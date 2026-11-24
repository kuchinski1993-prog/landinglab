// LandingLab · Apply Bundle Standalone processor (auto-bind + checkout handler).
//
// NOVA FILOSOFIA (2026-09-19, pós refactor cheerio):
//   NÃO substituímos o bundle da landing origem por um template padrão. Isso
//   quebrava layouts diferentes toda hora (Kaching, cc-pdp-offer, custom PDPs).
//
//   Agora só fazemos 3 coisas cirúrgicas via cheerio:
//     1. Anota data-landing-page-id no <body>
//     2. Anota data-landing-variant-id nos N primeiros "cards de bundle" que
//        detectarmos (Kaching, cc-pdp-offer, radio custom) — 1:1 com landing_variants
//        na ordem sort_order.
//     3. Injeta o script checkout-handler no final do <body> — intercepta cliques
//        nos cards (active swap) e no CTA final (POST pra /landing-checkout).
//
//   Bônus: remove só sticky ATC bars órfãos (que criam CTA duplicado). Não
//   removemos mais os wrappers cc-pdp-offers / kaching-bundles-block: o bundle
//   original é preservado inteiro.
//
// Enfileirado manualmente via apps/worker/apply-bundle-aurivita.mjs.

import {
  createClient,
  landingBundleOffers,
  landingHtmlSnapshots,
  landingMarkets,
  landingPages,
  landingPixels,
  landingVariants,
  productVariants,
} from '@blackshop/db';
import { currencyMinorUnitDigits, currencySymbol as pricingCurrencySymbol, minorUnitsToMajor } from '@blackshop/pricing';
import type { Job } from 'bullmq';
import * as cheerio from 'cheerio';
import { and, eq, asc, desc, like } from 'drizzle-orm';

import {
  classifyIdempotency,
  fingerprintRenderData,
  sha256Hex,
} from '../lib/apply-bundle-idempotency.js';
import {
  isShadowEnabled,
  runAdapterShadow,
} from '../lib/adapter-shadow.js';
import { resolveBundleAuthority } from '../lib/adapter-bundle-authority.js';
import { hasRehostedLandingAssets, isShopHashModuleLoader } from '../lib/apply-bundle-asset-rules.js';
import {
  isSemanticShadowEnabled,
  runSemanticShadow,
} from '../lib/semantic-shadow.js';
import { safeApplyHtmlMutation } from '../lib/html-safety.js';
import { resolveLandingGlobalPixel, type GlobalPixelSource } from '../lib/landing-global-pixel.js';
import { persistSnapshot } from '../lib/html-snapshot-repo.js';
import { subsWidgetMode } from '../lib/landing-subs-widget.js';
import {
  ctaLabelsFor,
  relabelCtaText,
  resolveWidgetLocale,
  subsBadgeText,
} from '../lib/landing-widget-i18n.js';
import { renderBundleLabels } from '../lib/render-bundle-labels.js';
import { renderBundleOffers } from '../lib/render-bundle-offers.js';
import { renderCurrencyConfig } from '../lib/render-currency-config.js';
import { renderProductJson } from '../lib/render-product-json.js';
import { logger } from '../logger.js';

export interface ApplyBundleJobData {
  landingPageId: string;
  /** @deprecated não usado mais (bundle padrão foi descontinuado) */
  locale?: string;
  /** @deprecated */
  subsEnabled?: boolean;
  /** @deprecated */
  sellingPlanId?: string | null;
  /** @deprecated */
  subsDiscountPct?: number;
}

/** Endpoint público do handler — configurado via env, com fallback. */
const CHECKOUT_API_URL =
  process.env['LANDING_CHECKOUT_URL'] ?? 'https://t.authenlondon.com/landing-checkout';

/**
 * Detecta os "cards de bundle" da landing origem, em ordem visual.
 * Ordem de tentativa cobre os padrões conhecidos (bepurex, aurivita, generic).
 */
function detectBundleCards($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  // 1. Kaching Bundles (bepurex): cada .kaching-bundles__bar com data-deal-bar-id
  const kaching = $('.kaching-bundles__bar[data-deal-bar-id]');
  if (kaching.length > 0) return kaching;

  // 2. Custom PDP theme (aurivita): button.cc-pdp-offer
  const ccpdp = $('button.cc-pdp-offer');
  if (ccpdp.length > 0) return ccpdp;

  // 3. Fastlane / volume-discount
  const fastlane = $(
    '[class*="bundle-selector"] [class*="option"], [class*="bundle-picker"] [class*="option"], [class*="volume-discount"] [class*="option"]',
  );
  if (fastlane.length > 0) return fastlane;

  // 4. Radio inputs num form action=/cart
  const radios = $('form[action*="/cart"] input[type="radio"][name="id"]').parent();
  if (radios.length > 0) return radios;

  // Nada detectado
  return $();
}

/**
 * Encontra o CTA principal de compra (add to cart / buy now) da landing origem.
 * Retorna o primeiro elemento fora de cart-drawer que seja o ATC canonical.
 */
function detectBuyCta($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  // 1. Botão Shopify padrão name="add" fora do cart-drawer
  const shopifyAdd = $('button[name="add"]')
    .filter((_, el) => $(el).closest('cart-drawer, .cart-drawer').length === 0)
    .first();
  if (shopifyAdd.length > 0) return shopifyAdd;

  // 2. Custom theme aurivita: .cc-pdp-buy-buttons button
  const aurivitaBuy = $('.cc-pdp-buy-buttons button, .cc-pdp__buy-cta, [data-atc-button]').first();
  if (aurivitaBuy.length > 0) return aurivitaBuy;

  // 3. Fallback: primeiro submit em form /cart
  const submit = $('form[action*="/cart"] button[type="submit"]').first();
  if (submit.length > 0) return submit;

  return $();
}

/** Escapa strings pra inclusão segura em código JS inline. */
function escapeJs(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/<\//g, '<\\/');
}

function isValidPixelId(id: string): boolean {
  return /^\d{13,17}$/.test(id.trim());
}

/**
 * Snippet Meta Pixel: loader oficial + PageView. AddToCart/InitiateCheckout
 * são disparados via handler client-side (checkout-handler script). Purchase
 * é server-side via CAPI (tracker-capi processor).
 */
/**
 * Marker exclusivo do LandingLab dentro do comentário HTML de abertura
 * do snippet Meta Pixel. Assinatura específica pra NÃO nukar comentários
 * legítimos do tema/site origem que digam "Meta Pixel" genericamente.
 */
const LANDINGLAB_PIXEL_OPEN_MARKER = 'Meta Pixel (LandingLab auto-injected)';
const LANDINGLAB_PIXEL_CLOSE_MARKER = 'End Meta Pixel';

/**
 * Remove os comentários HTML auto-injetados pelo LandingLab em snippets
 * anteriores de Meta Pixel (§7.15). Idempotente: rodar N vezes deixa
 * exatamente 0 comentários LandingLab.
 *
 * PRESERVA:
 * - Comentários legítimos de terceiros (ex: "<!-- Meta Pixel Code -->"
 *   inserido pelo tema origem sem a assinatura "LandingLab auto-injected").
 * - Comentários "End Meta Pixel" órfãos que NÃO estejam adjacentes a um
 *   marker LandingLab (podem pertencer ao pixel legítimo).
 *
 * REMOVE:
 * - Comentários contendo "Meta Pixel (LandingLab auto-injected)" (assinatura
 *   única do LandingLab).
 * - O "End Meta Pixel" IMEDIATAMENTE subsequente (permitindo whitespace/text
 *   node vazio no meio, mas não outro elemento).
 *
 * @param $ Instância cheerio da landing.
 */
function removeLandingLabPixelComments($: cheerio.CheerioAPI): void {
  // Coleta nodes a remover: abertura + text nodes intermediários
  // (whitespace-only) + fechamento adjacente.
  const nodesToRemove = new Set<unknown>();

  // NodeType shape (compatível com domhandler; typing loose pra evitar dep)
  type DomNode = { type?: string; data?: string; next?: unknown };

  $('*')
    .contents()
    .each((_, node) => {
      const commentNode = node as unknown as DomNode;
      if (commentNode.type !== 'comment' || !commentNode.data) return;
      if (!commentNode.data.includes(LANDINGLAB_PIXEL_OPEN_MARKER)) return;

      // Marca abertura + text/whitespace subsequentes até achar o close marker
      nodesToRemove.add(node);
      const pendingWhitespace: unknown[] = [];
      let cursor = commentNode.next as DomNode | null | undefined;
      while (cursor) {
        if (cursor.type === 'text') {
          const txt = cursor.data ?? '';
          // Só marca pra remoção text nodes 100% whitespace (evita nukar
          // conteúdo real que porventura esteja entre marker e close)
          if (/^\s*$/.test(txt)) {
            pendingWhitespace.push(cursor);
            cursor = cursor.next as typeof cursor;
            continue;
          }
          // Text não-vazio no meio → aborta remoção do close (preserva texto)
          break;
        }
        if (cursor.type === 'comment' && cursor.data?.includes(LANDINGLAB_PIXEL_CLOSE_MARKER)) {
          // Adjacente encontrado — remove close + whitespace intermediário
          nodesToRemove.add(cursor);
          for (const w of pendingWhitespace) nodesToRemove.add(w);
          break;
        }
        // Qualquer outro tipo (script/elemento/comment não-close): não segue
        // — proteção contra tocar em pixel legítimo com layout diferente.
        break;
      }
    });

  // Aplica remoções (evita mutar durante iteração)
  for (const node of nodesToRemove) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $(node as any).remove();
  }
}

function buildMetaPixelSnippet(pixelId: string, eventTestCode: string | null, deferMobileMs = 0): string {
  const testCodeInit = eventTestCode
    ? `fbq('set','autoConfig','false','${escapeJs(pixelId)}');fbq('init','${escapeJs(pixelId)}',{},{eventID:'${escapeJs(eventTestCode)}'});`
    : `fbq('init','${escapeJs(pixelId)}');`;
  const insertLoader = deferMobileMs > 0
    ? `if(window.matchMedia('(max-width: 768px)').matches){setTimeout(function(){s.parentNode.insertBefore(t,s)},${deferMobileMs});}else{s.parentNode.insertBefore(t,s);}`
    : 's.parentNode.insertBefore(t,s)';
  return `<!-- Meta Pixel (LandingLab auto-injected) -->
<script data-landinglab-pixel="loader">
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
${insertLoader}}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
${testCodeInit}
fbq('track','PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=${escapeJs(pixelId)}&ev=PageView&noscript=1"/></noscript>
<!-- End Meta Pixel -->`;
}

/**
 * Constrói o script asset-resurrector que substitui URLs Supabase quebradas
 * (404 NoSuchKey) pela URL CDN original quando possível. Roda no client-side
 * via onerror handler.
 *
 * Estratégia: pra cada asset com src Supabase Storage do nosso bucket,
 * adiciona um error handler. Se 404, extrai o filename hash e tenta cadeia
 * de fallbacks: sourceOrigin/cdn/shop/files/{hash}, cdn.shopify.com/s/files/1/.../
 * (heurística baseada em pattern). Sem match, deixa como está.
 * REMOVIDO: asset-resurrector desativado — estava criando 4 backup scripts
 * por asset failed (pra aurivita.co CDN) que retornavam CORS block, multiplicando
 * os erros em vez de resolver. Melhor deixar Supabase 404 do que gerar 4 CORS.
 */

/** Constrói o script checkout-handler que vai no </body>. */
function buildCheckoutHandlerScript(apiUrl: string): string {
  return `<script data-landinglab-checkout-handler>window.__LL_CHECKOUT_API__=${JSON.stringify(apiUrl)};(function(){
  var API = window.__LL_CHECKOUT_API__;
  function readCookie(n){ var m = document.cookie.match(new RegExp('(?:^|;\\\\s*)' + n + '=([^;]+)')); return m ? decodeURIComponent(m[1]) : null; }
  function readQuery(){ var out={}, s=window.location.search.slice(1); if(!s) return out; s.split('&').forEach(function(p){ var kv=p.split('='); if(kv[0]) out[decodeURIComponent(kv[0])]=decodeURIComponent(kv[1]||''); }); return out; }
  function collectAttribution(){ var q=readQuery(); var pick=function(k){return q[k]||readCookie(k)||null;}; return { fbclid: pick('fbclid'), fbp: readCookie('_fbp'), fbc: readCookie('_fbc'), utmSource: pick('utm_source'), utmMedium: pick('utm_medium'), utmCampaign: pick('utm_campaign'), utmContent: pick('utm_content'), utmTerm: pick('utm_term') }; }
  function findActiveVariantId(){
    var active = document.querySelector('[data-landing-variant-active="true"]');
    if(active) return active.getAttribute('data-landing-variant-id');
    var first = document.querySelector('[data-landing-variant-id]:not([data-landing-cta])');
    return first ? first.getAttribute('data-landing-variant-id') : null;
  }
  function findLandingPageId(){ var el = document.querySelector('[data-landing-page-id]'); return el ? el.getAttribute('data-landing-page-id') : null; }
  function pixelDataFor(vid, qty){
    var data = { content_ids:[vid], num_items:qty||1 };
    var cards = document.querySelectorAll('[data-landing-variant-id]:not([data-landing-cta])');
    for(var i=0; i<cards.length; i++){
      if(cards[i].getAttribute('data-landing-variant-id') !== vid) continue;
      var productId = cards[i].getAttribute('data-landing-pixel-product-id');
      var value = Number(cards[i].getAttribute('data-landing-pixel-value'));
      var currency = cards[i].getAttribute('data-landing-pixel-currency');
      if(productId){ data.content_ids = [productId]; data.content_type = 'product_group'; }
      if(currency && isFinite(value) && value > 0){ data.value = value; data.currency = currency; }
      break;
    }
    return data;
  }
  var __checkoutInflight = false;
  function checkout(vid, qty){
    if(!vid){ console.warn('[LandingLab] variantId ausente — botao nao configurado'); return; }
    if(__checkoutInflight){ return; } // dedup: previne double-fire (click + submit + capture)
    __checkoutInflight = true;
    try { if(typeof window.fbq === 'function') window.fbq('track', 'InitiateCheckout', pixelDataFor(vid, qty)); } catch(_) {}
    function tryOnce(retry){
      fetch(API, { method:'POST', credentials:'include', headers:{ 'content-type':'application/json' },
        body: JSON.stringify({ cartItems:[{ landingVariantId: vid, qty: qty||1 }], attribution: collectAttribution(), landingPageId: findLandingPageId() })
      }).then(function(r){ return r.json().catch(function(){ return null; }); }).then(function(d){
        if(d && d.checkoutUrl){ window.location.assign(d.checkoutUrl); return; }
        // Sem checkoutUrl: retry silencioso 1x com pequeno delay
        if(!retry){ setTimeout(function(){ tryOnce(true); }, 400); return; }
        console.warn('[LandingLab] checkout response sem checkoutUrl:', d);
        __checkoutInflight = false;
      }).catch(function(err){
        if(!retry){ setTimeout(function(){ tryOnce(true); }, 400); return; }
        console.warn('[LandingLab] checkout error:', err);
        __checkoutInflight = false;
      });
    }
    tryOnce(false);
  }
  function ensureDefaultActive(){
    var already = document.querySelector('[data-landing-variant-active="true"]');
    if(already){ syncCtaPrices(already); return; }
    // Prefere card pre-selected por CSS do tema
    var pre = document.querySelector('[data-landing-variant-id].kaching-bundles__bar--selected, [data-landing-variant-id].is-selected, [data-landing-variant-id].cc-pdp-offer--selected');
    if(pre){
      // Limpa is-selected dos outros pra so o correto brilhar
      var all1 = document.querySelectorAll('[data-landing-variant-id]:not([data-landing-cta])');
      for(var i1=0; i1<all1.length; i1++){
        if(all1[i1] !== pre) all1[i1].classList.remove('is-selected','is-highlighted');
      }
      pre.setAttribute('data-landing-variant-active', 'true');
      pre.classList.add('is-selected','is-highlighted');
      syncCtaPrices(pre); return;
    }
    var first = document.querySelector('[data-landing-variant-id]:not([data-landing-cta])');
    if(first){
      first.setAttribute('data-landing-variant-active', 'true');
      first.classList.add('is-selected','is-highlighted');
      syncCtaPrices(first);
    }
  }
  function initCta(){ ensureDefaultActive(); watchCta(); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCta);
  else initCta();
  // Belt+suspenders: reforce a cada 500ms nos primeiros 5s (product-form pode
  // reescrever após web-component upgrade, que roda em módulos assíncronos).
  var ctaAttempts = 0;
  var ctaTimer = setInterval(function(){
    var active = document.querySelector('[data-landing-variant-active="true"]');
    if(active) syncCtaPrices(active);
    watchCta();
    ctaAttempts++;
    if(ctaAttempts > 10) clearInterval(ctaTimer);
  }, 500);
  // MutationObserver: se o web component <product-form> reescrever os spans do
  // CTA de volta pro preço USD do tema, dispara syncCtaPrices novamente. Roda
  // sempre que o CTA muda childList.
  var ctaObserver = null;
  function watchCta(){
    var cta = document.querySelector('[data-landing-cta="buy"]');
    if(!cta || cta.dataset.llCtaWatched) return;
    cta.dataset.llCtaWatched = '1';
    var syncing = false;
    ctaObserver = new MutationObserver(function(){
      if(syncing) return;
      syncing = true;
      var active = document.querySelector('[data-landing-variant-active="true"]');
      if(active) syncCtaPrices(active);
      setTimeout(function(){ syncing = false; }, 100);
    });
    ctaObserver.observe(cta, { childList: true, subtree: true, characterData: true });
  }
  function syncCtaPrices(card){
    // Extrai preço e compare do card selecionado e reflete no CTA principal.
    // Cobre Aurivita (.cc-pdp-offer__price), Kaching (.kaching-bundles__bar-price)
    // e temas genéricos ([class*="__price"] excluindo compare/full-price).
    var priceEl = card.querySelector('.cc-pdp-offer__price, .kaching-bundles__bar-price, [data-cc-price], [class*="__price"]:not([class*="compare"]):not([class*="full-price"])');
    var compareEl = card.querySelector('.cc-pdp-offer__compare, .kaching-bundles__bar-compare, [data-cc-compare], [class*="__compare"], [class*="__full-price"]');
    var priceTxt = priceEl ? priceEl.textContent.trim() : '';
    var compareTxt = compareEl ? compareEl.textContent.trim() : '';
    if(!priceTxt) return;
    // BUG-M2: CTA acumulava preços antigos (€59.99€39.98€202.50) quando o
    // theme mantinha spans de preço "hidden" ou nao-detectados pelo loop.
    // Fix: limpar QUALQUER text node/span que contenha padrao de preço no
    // container e reescrever do zero.
    var priceRx = /[€$£¥]\s*[\d.,]+|\d+[.,]\d{2}\s*[€$£¥]/g;
    var ctaContainers = document.querySelectorAll('[data-cc-atc-append], .main-atc__price, .product-form__price');
    for(var i=0; i<ctaContainers.length; i++){
      var container = ctaContainers[i];
      // Passo 1: apagar todo texto de preço em text nodes órfãos + spans
      var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
      var textNodes = [];
      while(walker.nextNode()) textNodes.push(walker.currentNode);
      for(var t=0; t<textNodes.length; t++){
        var tn = textNodes[t];
        if(priceRx.test(tn.data)){
          tn.data = tn.data.replace(priceRx, '').replace(/\s{2,}/g, ' ');
        }
      }
      // Passo 2: identificar spans corretos por semântica de estilo:
      //  - priceSpan: font-weight bold (600+) OU classe com "price" mas SEM line-through
      //  - compareSpan: line-through explícito
      //  - separator (·): opacity baixo ou aria-hidden — NUNCA sobrescrever
      var spans = container.querySelectorAll('span');
      var priceDone = false, compareDone = false;
      for(var j=0; j<spans.length; j++){
        var sp = spans[j];
        if(sp.children.length > 0) continue; // pular wrappers
        var style = (sp.getAttribute('style') || '').toLowerCase();
        var cls = (sp.className || '').toString().toLowerCase();
        var aria = sp.getAttribute('aria-hidden');
        var txt = sp.textContent || '';
        var hasPricePattern = priceRx.test(txt);
        priceRx.lastIndex = 0; // reset (global regex)
        var isCompare = style.includes('line-through') || cls.includes('compare') || cls.includes('was') || cls.includes('old');
        var isSeparator = aria === 'true' || (style.includes('opacity') && !style.includes('opacity:1')) && !hasPricePattern;
        var isPriceSpan = !isCompare && !isSeparator && (style.includes('font-weight:6') || style.includes('font-weight: 6') || style.includes('font-weight:7') || cls.includes('price') || hasPricePattern);
        if(!priceDone && isPriceSpan){
          sp.textContent = priceTxt; priceDone = true;
        } else if(!compareDone && isCompare){
          sp.textContent = compareTxt || ''; compareDone = true;
        }
      }
      if(priceDone || compareDone) break;
    }
    // Kaching: o preço fica inline no texto do botão "Add to cart - $39.00".
    // .shop-add-to-cart-button > span.button-text (data-no-override="true" apenas
    // bloqueia override do tema nativo — não impede nossa atualização).
    var kachingBtns = document.querySelectorAll('.shop-add-to-cart-button .button-text, .kaching-bundles__cta .button-text');
    var inlinePriceRx = /([€$£¥]\s*[\d.,]+|\d+[.,]\d{2}\s*[€$£¥])/;
    for(var k=0; k<kachingBtns.length; k++){
      var kSpan = kachingBtns[k];
      if(inlinePriceRx.test(kSpan.textContent)){
        kSpan.textContent = kSpan.textContent.replace(inlinePriceRx, priceTxt);
      }
    }
  }
  var lastAddToCartVid = null;
  function fireAddToCart(vid, qty){
    if(!vid || lastAddToCartVid === vid) return;
    lastAddToCartVid = vid;
    try { if(typeof window.fbq === 'function') window.fbq('track', 'AddToCart', pixelDataFor(vid, qty)); } catch(_) {}
  }
  function handleBundleClick(e){
    var t = e.target;
    while(t && t !== document.body){
      var vid = t.getAttribute && t.getAttribute('data-landing-variant-id');
      if(vid){
        var isBuy = t.getAttribute('data-landing-cta') === 'buy';
        if(!isBuy){
          // Troca active + estado visual do tema (is-selected/is-highlighted).
          // Sem isso o tema aurivita fica marcando o card pre-selected sempre,
          // usuario nao ve feedback visual do card clicado.
          var all = document.querySelectorAll('[data-landing-variant-id]:not([data-landing-cta])');
          for(var i=0; i<all.length; i++){
            all[i].removeAttribute('data-landing-variant-active');
            all[i].classList.remove('is-selected','is-highlighted','is-active','active','kaching-bundles__bar--selected');
            all[i].setAttribute('aria-selected','false');
          }
          t.setAttribute('data-landing-variant-active', 'true');
          t.classList.add('is-selected','is-highlighted');
          t.setAttribute('aria-selected','true');
          fireAddToCart(vid, parseInt(t.getAttribute('data-landing-qty') || '1', 10));
          syncCtaPrices(t);
        } else {
          e.preventDefault(); e.stopPropagation();
          if(e.stopImmediatePropagation) e.stopImmediatePropagation();
          checkout(vid, parseInt(t.getAttribute('data-landing-qty') || '1', 10));
        }
        return;
      }
      t = t.parentElement;
    }
  }
  document.addEventListener('pointerdown', handleBundleClick, true);
  document.addEventListener('click', handleBundleClick, true);

  // Buy button sem variant explícito → usa o ativo
  document.addEventListener('click', function(e){
    var t = e.target;
    while(t && t !== document.body){
      if(t.getAttribute && t.getAttribute('data-landing-cta') === 'buy' && !t.getAttribute('data-landing-variant-id')){
        e.preventDefault(); e.stopPropagation();
        if(e.stopImmediatePropagation) e.stopImmediatePropagation();
        checkout(findActiveVariantId(), parseInt(t.getAttribute('data-landing-qty') || '1', 10));
        return;
      }
      t = t.parentElement;
    }
  }, true);
  // Form submit /cart/add fallback
  document.addEventListener('submit', function(e){
    var f = e.target;
    if(f && f.action && f.action.indexOf('/cart/add') !== -1){
      e.preventDefault(); e.stopPropagation();
      checkout(findActiveVariantId(), 1);
    }
  }, true);
})();</script>`;
}

/** Constrói o script FAQ accordion handler — separado do checkout-handler para
 *  que o sanitizer do storefront possa preservá-lo independentemente. */
function buildFaqHandlerScript(): string {
  return `<script data-landinglab-faq-handler>(function(){
  var faqStylesInjected = false;
  function ensureFaqFallbackStyles(){
    if(faqStylesInjected) return;
    faqStylesInjected = true;
    var st = document.createElement('style');
    st.setAttribute('data-landinglab-faq-fallback', '');
    st.textContent =
      '.cc-pdp-faqs__item .cc-pdp-faqs__answer-wrap,' +
      '.cc-faq__item .cc-faq__answer-wrap{' +
        'display:grid;grid-template-rows:0fr;overflow:hidden;' +
        'transition:grid-template-rows .3s ease;' +
      '}' +
      '.cc-pdp-faqs__item.is-open .cc-pdp-faqs__answer-wrap,' +
      '.cc-faq__item.is-open .cc-faq__answer-wrap{' +
        'grid-template-rows:1fr;' +
      '}' +
      '.cc-pdp-faqs__item .cc-pdp-faqs__answer-wrap > *,' +
      '.cc-faq__item .cc-faq__answer-wrap > *{min-height:0;}' +
      '.csi-panel{max-height:0;overflow:hidden;transition:max-height .3s ease;}' +
      '.csi-item.is-open .csi-panel,.csi-item.open .csi-panel{max-height:1000px;}';
    document.head.appendChild(st);
  }
  function toggleAccordion(item, siblingSel){
    var group = item.parentElement;
    var isOpen = item.classList.contains('is-open') || item.classList.contains('open');
    if(group){
      var siblings = group.querySelectorAll(siblingSel);
      for(var i=0; i<siblings.length; i++) {
        if(siblings[i] !== item) {
          siblings[i].classList.remove('is-open');
          siblings[i].classList.remove('open');
        }
      }
    }
    if(isOpen){
      item.classList.remove('is-open');
      item.classList.remove('open');
    } else {
      item.classList.add('is-open');
    }
  }
  function handleFaqClick(e){
    ensureFaqFallbackStyles();
    var t = e.target;
    while(t && t !== document.body){
      if(t.classList){
        if(t.classList.contains('cc-pdp-faqs__toggle')){
          var item1 = t.closest('.cc-pdp-faqs__item');
          if(item1){ e.preventDefault(); e.stopPropagation(); if(e.stopImmediatePropagation) e.stopImmediatePropagation(); toggleAccordion(item1, '.cc-pdp-faqs__item'); return; }
        }
        if(t.classList.contains('cc-faq__toggle')){
          var item2 = t.closest('.cc-faq__item');
          if(item2){ e.preventDefault(); e.stopPropagation(); if(e.stopImmediatePropagation) e.stopImmediatePropagation(); toggleAccordion(item2, '.cc-faq__item'); return; }
        }
        if(t.classList.contains('csi-item-trigger')){
          var item3 = t.closest('.csi-item');
          if(item3){ e.preventDefault(); e.stopPropagation(); if(e.stopImmediatePropagation) e.stopImmediatePropagation(); toggleAccordion(item3, '.csi-item'); return; }
        }
        // Klensia .faq-img-question: handler de fallback via event delegation.
        // Guard data-faq-img-init removido: o sanitizer substitui nós DOM, então
        // listeners do nativo (initFaqImgSection) ficam em nós antigos — inválidos.
        // Este handler sempre assume controle; llAccWired no botão (via accordion-fix)
        // garante que não há double-fire quando o wireKlensiaFaq também wired.
        if(t.classList.contains('faq-img-question')){
          var faqItem = t.closest ? t.closest('.faq-img-item') : null;
          if(!faqItem && t.parentElement) faqItem = t.parentElement.classList.contains('faq-img-item') ? t.parentElement : null;
          if(faqItem){
            var faqAnswer = faqItem.querySelector('.faq-img-answer');
            var faqIsOpen = faqItem.classList.contains('is-open');
            var faqGroup = faqItem.parentElement;
            if(faqGroup){
              var faqSiblings = faqGroup.querySelectorAll('.faq-img-item.is-open');
              for(var fi=0; fi<faqSiblings.length; fi++){
                if(faqSiblings[fi] !== faqItem){
                  faqSiblings[fi].classList.remove('is-open');
                  var sAns = faqSiblings[fi].querySelector('.faq-img-answer');
                  if(sAns) sAns.style.maxHeight = '0px';
                }
              }
            }
            if(faqIsOpen){
              faqItem.classList.remove('is-open');
              t.setAttribute('aria-expanded','false');
              if(faqAnswer) faqAnswer.style.maxHeight = '0px';
            } else {
              faqItem.classList.add('is-open');
              t.setAttribute('aria-expanded','true');
              if(faqAnswer) faqAnswer.style.maxHeight = (faqAnswer.scrollHeight || 600) + 'px';
            }
            e.preventDefault(); e.stopPropagation(); if(e.stopImmediatePropagation) e.stopImmediatePropagation();
            return;
          }
        }
        // PSS accordion: togla is-open no panel via aria-controls / data-target
        if(t.classList.contains('pss-accordion-trigger')){
          var pssPanel = null;
          var dataTarget = t.getAttribute('data-target') || t.getAttribute('data-id');
          if(dataTarget){
            var targetId = dataTarget.replace(/^#/, '');
            pssPanel = document.getElementById(targetId) || document.querySelector('[data-panel-id="' + targetId + '"]');
          }
          if(!pssPanel){
            var ariaCtrl = t.getAttribute('aria-controls');
            if(ariaCtrl) pssPanel = document.getElementById(ariaCtrl);
          }
          if(!pssPanel) pssPanel = t.nextElementSibling;
          if(!pssPanel && t.parentElement) pssPanel = t.parentElement.querySelector('.pss-accordion-panel');
          if(pssPanel){
            e.preventDefault(); e.stopPropagation();
            var expanded = t.getAttribute('aria-expanded') === 'true';
            t.setAttribute('aria-expanded', expanded ? 'false' : 'true');
            if(expanded){ pssPanel.classList.remove('is-open'); }
            else { pssPanel.classList.add('is-open'); }
            return;
          }
        }
      }
      t = t.parentElement;
    }
  }
  // Capture phase — roda ANTES dos handlers originais do tema.
  document.addEventListener('click', handleFaqClick, true);
})();</script>`;
}

export async function processApplyBundle(
  job: Job<ApplyBundleJobData>,
): Promise<{
  ok: true;
  variantsBound: number;
  ctaAnnotated: boolean;
  stickyRemoved: number;
  handlerInjected: boolean;
  assetsChecked: number;
  assetsFixed: number;
  themeAssetsInjected: number;
  htmlBytesBefore: number;
  htmlBytesAfter: number;
}> {
  const { landingPageId } = job.data;

  logger.info({ jobId: job.id, landingPageId }, 'apply-bundle: started');

  const { db, sql } = createClient({
    databaseUrl:
      process.env['DATABASE_URL'] ??
      'postgresql://blackshop:changeme@localhost:5432/blackshop',
  });

  try {
    // 1. Puxa landing + variants (ordenados por sort_order)
    const [page] = await db
      .select()
      .from(landingPages)
      .where(eq(landingPages.id, landingPageId))
      .limit(1);

    if (!page) throw new Error(`landing_page ${landingPageId} not found`);
    if (!page.htmlBody) throw new Error(`landing_page ${landingPageId} has no html_body`);

    // ─────────────────────────────────────────────────────────────────
    // Dual-read (Fase 4 do Stabilization Roadmap, 25/09/2026):
    //
    // Fonte canônica NOVA: landing_bundle_offers (UI edita aqui)
    // Fonte LEGACY: landing_variants (mantida pra rollback)
    //
    // Estratégia:
    //   1. Sempre lê AMBAS em paralelo (queries paralelas, ~mesma latência)
    //   2. Se bundle_offers tem rows → usa (adaptado pro formato interno)
    //   3. Senão → fallback pra landing_variants (legado)
    //   4. Logga source escolhida pra observabilidade
    //
    // Ao mapear bundle_offers → formato interno (variants shape):
    //   - price_cents (int) → price (numeric string 'X.YY')
    //   - compare_at_cents → compare_at_price (numeric string ou null)
    //   - qty → quantityOfItems
    //   - position → sortOrder
    //   - title → name
    //   - variant_id (text GID numérico) → mirrorVariantId
    //   - lvId = bundle_offer.id (não colide com landing_variant.id — usado só interno)
    // ─────────────────────────────────────────────────────────────────
    const [bundleOffersRows, legacyVariantsRows] = await Promise.all([
      db
        .select({
          boId: landingBundleOffers.id,
          title: landingBundleOffers.title,
          qty: landingBundleOffers.qty,
          position: landingBundleOffers.position,
          priceCents: landingBundleOffers.priceCents,
          compareAtCents: landingBundleOffers.compareAtCents,
          variantId: landingBundleOffers.variantId,
          badge: landingBundleOffers.badge,
        })
        .from(landingBundleOffers)
        .where(eq(landingBundleOffers.landingPageId, landingPageId))
        .orderBy(asc(landingBundleOffers.position)),
      db
        .select({
          lvId: landingVariants.id,
          name: landingVariants.name,
          quantityOfItems: landingVariants.quantityOfItems,
          sortOrder: landingVariants.sortOrder,
          productId: productVariants.productId,
          mirrorVariantId: productVariants.mirrorVariantId,
          price: landingVariants.price,
          compareAtPrice: landingVariants.compareAtPrice,
        })
        .from(landingVariants)
        .leftJoin(productVariants, eq(productVariants.id, landingVariants.productVariantId))
        .where(eq(landingVariants.landingPageId, landingPageId))
        .orderBy(asc(landingVariants.sortOrder)),
    ]);

    // Prefere bundle_offers quando disponível. Adapta pra shape que o resto
    // do processor já espera (não requer refactor massivo aqui).
    let variants: Array<{
      lvId: string;
      name: string;
      quantityOfItems: number;
      sortOrder: number;
      productId: string | null;
      mirrorVariantId: string | null;
      price: string;
      compareAtPrice: string | null;
    }>;
    let variantsSource: 'bundle_offers' | 'landing_variants_legacy' | 'none';

    if (bundleOffersRows.length > 0) {
      variantsSource = 'bundle_offers';
      variants = bundleOffersRows.map((o) => ({
        lvId: o.boId,
        name: o.title || `Bundle ${o.position + 1}`,
        quantityOfItems: o.qty,
        sortOrder: o.position,
        productId: null, // bundle_offers não tem — só usado no pixel Meta legado (Fase 16 corrige)
        mirrorVariantId: o.variantId, // já é GID numérico Shopify (populado pelo publish-shopify)
        price: (() => { const cur = (page.currency ?? 'EUR').toUpperCase(); return minorUnitsToMajor(o.priceCents, cur).toFixed(currencyMinorUnitDigits(cur)); })(),
        compareAtPrice:
          o.compareAtCents !== null && o.compareAtCents !== undefined
            ? (() => { const cur = (page.currency ?? 'EUR').toUpperCase(); return minorUnitsToMajor(o.compareAtCents!, cur).toFixed(currencyMinorUnitDigits(cur)); })()
            : null,
      }));
    } else if (legacyVariantsRows.length > 0) {
      variantsSource = 'landing_variants_legacy';
      variants = legacyVariantsRows.map((v) => ({
        lvId: v.lvId,
        name: v.name,
        quantityOfItems: v.quantityOfItems,
        sortOrder: v.sortOrder,
        productId: v.productId,
        mirrorVariantId: v.mirrorVariantId,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
      }));
    } else {
      variantsSource = 'none';
      variants = [];
    }

    logger.info(
      {
        jobId: job.id,
        landingPageId,
        variantsSource,
        variantsCount: variants.length,
        bundleOffersFound: bundleOffersRows.length,
        legacyVariantsFound: legacyVariantsRows.length,
      },
      'apply-bundle: variants source resolved',
    );

    // landing_pages.currency → símbolo pro HTML dos cards.
    // Fase 8B (Landing Lab Stabilization): fonte primária é @blackshop/pricing.
    // Overrides locais preservam compat visual pré-Fase 8 pra 4 moedas onde
    // o pacote (Intl.NumberFormat) diverge do que os cards Kaching esperam:
    //   CAD:  pacote='$'  worker='C$'  (distinguível de USD)
    //   AUD:  pacote='$'  worker='A$'  (distinguível de USD)
    //   CHF:  pacote='CHF' worker='CHF ' (espaço requerido pelo layout)
    //   DKK:  pacote='kr.' worker='kr'  (histórico sem ponto)
    // JPY: pacote='￥' full-width; worker legacy='¥' half-width — divergência
    // aceitável (nunca renderizamos JPY até hoje, override cosmético opcional).
    const CURRENCY_OVERRIDES: Record<string, string> = {
      CAD: 'C$',
      AUD: 'A$',
      CHF: 'CHF ',
      DKK: 'kr',
    };
    const pageCurrencyCode = (page.currency ?? 'EUR').toUpperCase();
    const currencySymbol =
      CURRENCY_OVERRIDES[pageCurrencyCode] ?? pricingCurrencySymbol(pageCurrencyCode);
    const fmtPrice = (val: string | number | null): string => {
      if (val === null || val === undefined || val === '') return '';
      const num = typeof val === 'number' ? val : parseFloat(String(val));
      if (isNaN(num)) return String(val);
      const digits = currencyMinorUnitDigits(pageCurrencyCode);
      const formatted = digits === 0
        ? Math.round(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        : num.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return `${currencySymbol}${formatted}`;
    };
    // Escapa caracteres HTML pra atributos e conteúdo texto (widget subs, etc).
    const escapeHtml = (str: string): string =>
      String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    if (variants.length === 0) {
      logger.warn(
        { jobId: job.id, landingPageId, variantsSource },
        'apply-bundle: no variants in bundle_offers NOR landing_variants — will only inject handler',
      );
    }

    const bytesBefore = page.htmlBody.length;
    const $ = cheerio.load(page.htmlBody);

    // 2. data-landing-page-id no <body> — sempre sobrescreve: o HTML clonado pode
    // carregar o ID da landing origem (ex: Klensia ce453ca8), não desta landing.
    $('body').attr('data-landing-page-id', landingPageId);

    // 3. Remove sticky ATC bars órfãos (criam CTA duplicado que confunde)
    const stickyRemoved = $('.cc-sticky-atc, .kaching-sticky-atc, .shopify-sticky-cart, .sticky-atc-container').length;
    $('.cc-sticky-atc, .kaching-sticky-atc, .shopify-sticky-cart, .sticky-atc-container').remove();

    // 3.5. Remove scripts que quebram em runtime (chunks 400, dynamic imports
    //      pra features que não existem no nosso storefront). Cada um deles
    //      dispara requests pra URLs Supabase que retornam 400 NoSuchKey,
    //      causando 100+ erros de console e travando features do tema
    //      (acordeões FAQs, cart drawer, etc).
    let brokenScriptsRemoved = 0;
    $('script').each((_, el) => {
      const $el = $(el);
      const src = ($el.attr('src') || '').toLowerCase();
      const inner = ($el.html() || '').slice(0, 800).toLowerCase();
      const shouldRemove =
        // Kaching bundles loader
        /kaching-bundles\.js|kaching\.bundles|kaching-widget/.test(src) ||
        /kaching-bundles\.js|kaching-widget/.test(inner) ||
        // Shopify shop-js runtime (featureAssets → tenta baixar chunks .esm.js)
        /window\.shopify\.featureassets|shopify\.featureassets/.test(inner) ||
        /shopifycloud\/shop-js|\/shop-js\/|shop\.js/.test(src) ||
        // Shopify cart-sync (não temos backend Shopify)
        /shop-cart-sync|init-shop-cart-sync/.test(src) ||
        // Shopify SignInWithShop / initShopCartSync inline module (QA 2026-09-29):
        // Alguns clones contêm um <script type=module> que faz
        // `await import("<hashed-loader>.js")` + `window.Shopify.SignInWithShop?.initShopCartSync(...)`.
        // O src é apenas o hash (sem "shop-cart-sync"), mas o inner delata. O loader tenta importar
        // ~17 chunks .esm.js do Supabase que nunca foram uploadados → 400 NoSuchKey em cascata +
        // pageerror "Failed to fetch dynamically imported module". Storefront não usa cart sync Shopify,
        // então remover é seguro.
        /signinwithshop|initshopcartsync/.test(inner) ||
        // Shopify standard_actions inline (QA 2026-09-29):
        // <script data-source-attribution="shopify.standard_actions"> carrega runtime que
        // aciona `createShopifyExtend`. Sem o resto do Shopify ambient, dispara
        // "Cannot read properties of undefined (reading 'createShopifyExtend')".
        /data-source-attribution=["']shopify\.standard_actions/.test($el.toString()) ||
        // Shopify dynamic_checkout inline (portableWallets, buyerConsent):
        // Injeta portable-wallets.en.js e buyer consent UI — sem Shopify Pay ambient, ambos falham.
        /data-source-attribution=["']shopify\.dynamic_checkout/.test($el.toString()) ||
        // Conteúdo inline que referencia portable-wallets (fallback por inner)
        /isStorefrontPortableWallets|portableWalletsHideBuyerConsent/.test(inner) ||
        // web-pixels-manager (aurivita.co CORS)
        /web-pixels-manager|shopifycloud\/boomerang/.test(src) ||
        // Klaviyo onsite forms (popup)
        /klaviyo\.js|klaviyo-onsite|static\.klaviyo/.test(src) ||
        /klaviyo\.push|klaviyo_onsite/.test(inner) ||
        // Inline scripts que fazem fetch pra aurivita.co (analytics coletores)
        /aurivita\.co\/api\/collect|aurivita\.co\/collect|api\/analytics\/collect/.test(inner) ||
        // Web pixel manager inline
        /web-pixels-manager|__webpixelsmanager/.test(inner) ||
        // Trekkie inline registration
        /trekkie|Shopify\.analytics/.test(inner) ||
        // Shopify inline runtime (init, Boomerang, shopifyanalytics)
        /shopify\.loadfeatures|shopifyanalytics|window\.boomr/.test(inner) ||
        // Google Tag Manager inline
        /gtag|dataLayer\.push|www\.googletagmanager/.test(inner) ||
        // Doubleclick / conversion tracking
        /ad\.doubleclick|googleadservices|conversion_async/.test(inner) ||
        // Klaviyo inline
        /_learnq\.push|klaviyo|var _klOnsite/.test(inner) ||
        // Aimerce inline
        /aimerce|aim_init|aim_page_view/.test(inner) ||
        // Alia inline
        /alia-prod|backend\.alia/.test(inner) ||
        // Config Security inline
        /config-security|conf\.config/.test(inner) ||
        // Shop Pay / Shopify Pay
        /shop\.app|shop_pay|shopify_pay/.test(inner) ||
        // Merchant Center Analytics
        /merchant-center-analytics/.test(inner) ||
        // Cloudfront chunks Shopify
        /d33a6lvgbd0fej|ds0wlyksfn0sb\.cloudfront/.test(inner) ||
        // Shopifysvc monorail POST
        /monorail-edge\.shopifysvc|otlp-http.*shopifysvc|shopifysvc\.com\/v1/.test(inner) ||
        // spfy-pxl archive-digger
        /spfy-pxl|archive-digger/.test(inner) ||
        // Aurivita.co qualquer fetch/XHR inline
        /aurivita\.co\//.test(inner) ||
        // Cart Ajax (retorna 405 - nosso storefront não é Shopify)
        /\/cart\/(add|update|change|clear)\.js|\/cart\.js|\/cart\.json|\/products\/[^"']+\.js/.test(inner) ||
        // Shopify well-known endpoints (405)
        /\.well-known\/shopify\/(monorail|fec)/.test(inner) ||
        // Shopify_pay accelerated_checkout
        /shopify_pay\/accelerated_checkout/.test(inner) ||
        // Shopify Checkout Extensions preloads.js — dispara 100+ requests
        // /shopify/monorail/produce_batch (405), /collect (404), hooks-*, etc
        /\/preloads\.js|\/preload\.js|checkout\.shopify\.com/.test(src) ||
        /_shopify\/checkout|checkout-extensions|ui-extensions/.test(src) ||
        // Monorail telemetry (405s)
        /monorail-edge|monorail\.produce/.test(src) ||
        // Config Security tracking
        /config-security\.com|api\.config-security/.test(src) ||
        // Lucky Orange (visitor recording)
        /luckyorange|tools\.luckyorange/.test(src) ||
        // Aimerce tracking (dispara CORS aurivita.co/api/collect)
        /aimerce|e\.aimerce\.ai/.test(src) ||
        // Alia
        /alia-prod|backend\.alia/.test(src) ||
        // Taboola
        /taboola\.com/.test(src) ||
        // Trafficjunky ads
        /trafficjunky/.test(src) ||
        // Intelligems config
        /intelligems\.io|cdn\.intelligems/.test(src) ||
        // Trekkie Shopify (dispara CORS pra aurivita.co/api/collect)
        /trekkie\.storefront|\/cdn\/s\/trekkie/.test(src) ||
        // Qualquer script apontando pra aurivita.co que não seja imagem
        /aurivita\.co\/(?:cdn|api|cart|checkout|web-pixels)/.test(src) ||
        // Aca (Klaviyo abandoned cart)
        /aca\.506\.io|aca-main/.test(src) ||
        // Cloudfront Shopify runtime chunks
        /d33a6lvgbd0fej|ds0wlyksfn0sb\.cloudfront/.test(src) ||
        // Aimerce cdn
        /cdn\.aimerce/.test(src) ||
        // Securykit
        /data\.securykit|securykit\.com/.test(src) ||
        // Shopify service (monorail/pxl)
        /shopifysvc\.com|spfy-pxl|archive-digger/.test(src) ||
        // Klaviyo tracking
        /static-tracking\.klaviyo|static\.klaviyo|a\.klaviyo/.test(src) ||
        // Google Tag Manager runtime chunks se tá muito quebrado
        /www\.googletagmanager\.com\/gtm\.js/.test(src) ||
        // 506 (Klaviyo add-on)
        /506\.io/.test(src) ||
        // Shopify shop-cart-sync ESM entry (QA 2026-09-29):
        // O loader principal do shop-cart-sync é um arquivo de hash hex puro (ex: ccef5b00ef4d093c.js)
        // armazenado no Supabase storage. O src não contém "shop-cart-sync" mas o arquivo
        // contém apenas 18 imports de chunks *.esm.js que nunca foram uploadados.
        // Detectado: src aponta para Supabase storage da landing + nome é hash hex 16 chars + type=module.
        // Sem o type=module apagava os 22 JS próprios da landing (o cloner nomeia todos por hash) —
        // galeria e carrossel de vídeo travavam depois de publicar (2026-11-24).
        isShopHashModuleLoader(src, $el.attr('type')) ||
        // shop-cart-sync também pode ter data-shopify-feature="shop-cart-sync" no elemento
        /shop-cart-sync|init-shop-cart-sync/.test($el.attr('data-shopify-feature') || '') ||
        /shop-cart-sync|init-shop-cart-sync/.test($el.attr('data-source-component') || '');
      if (shouldRemove) {
        $el.remove();
        brokenScriptsRemoved++;
      }
    });

    // 3.5.0.0. Remove custom elements órfãos do Shopify runtime (shop-cart-sync etc).
    //          Após remover os scripts acima, esses elementos ficam sem registro → erro console.
    $('shop-cart-sync, shop-paypal-button, shop-login-button').each((_, el) => {
      $(el).remove();
    });

    // 3.5.0.1. Remove <img> pixels de tracking que também vazam (trafficjunky)
    let trackingPixelsRemoved = 0;
    $('img').each((_, el) => {
      const src = ($(el).attr('src') || '').toLowerCase();
      if (/trafficjunky|taboola\.com|config-security/.test(src)) {
        $(el).remove();
        trackingPixelsRemoved++;
      }
    });

    // 3.5.0.2. Remove <iframe> quebrados que fazem framing (CSP block)
    // Declarado aqui — usado em iframes (968), preloads (997) e scripts (1023/1030).
    const ORIGIN_STORE_HOSTS =
      /(?:klensia\.com|klensia\.website|aurivita\.co|bepurex\.com|metabolae\.[a-z]+|vigoraxi\.com|17svvv-zf\.myshopify\.com)/i;
    let brokenIframesRemoved = 0;
    $('iframe').each((_, el) => {
      const src = ($(el).attr('src') || '').toLowerCase();
      const name = ($(el).attr('name') || '').toLowerCase();
      if (
        /aurivita\.co|shopify\.com\/checkouts/.test(src) ||
        // Shopify Web Pixel sandbox iframes (web-pixels@... src ou name padrão)
        /web-pixel-sandbox|web-pixels@/.test(name) ||
        (ORIGIN_STORE_HOSTS.test(src) && /web-pixels@/.test(src))
      ) {
        $(el).remove();
        brokenIframesRemoved++;
      }
    });

    // 3.5.1. Remove <link rel="modulepreload|preload|prefetch"> quebrados/inúteis.
    // Cobre:
    //   - Chunks .esm.js do Supabase que retornam 400 NoSuchKey
    //   - Prefetches Shopify /cdn/shopifycloud/checkout-web/* (404 na nossa CDN,
    //     Shopify carrega os próprios quando visitante vai ao checkout de fato).
    //   - Preloads apontando pra domínios de lojas origem (klensia.com,
    //     aurivita.co, bepurex.com, myshopify.com) — bloqueados por CSP e/ou
    //     retornam CORS, cada um custa ~500ms de conexão fantasma.
    // Ganho medido na Klensia: -35% DOM Complete, -70% requests na advertorial.
    let brokenPreloadsRemoved = 0;
    $('link[rel="modulepreload"], link[rel="preload"], link[rel="prefetch"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const asAttr = $(el).attr('as') || '';
      const shouldRemove =
        /\.esm\.js|shop-js|chunk\.|kaching/.test(href) ||
        (asAttr === 'script' && /\.supabase\.co\/storage/.test(href)) ||
        // Prefetches Shopify checkout-web (funcionam só no domínio Shopify real,
        // no nosso storefront viram 404).
        /\/cdn\/shopifycloud\/checkout-web\//i.test(href) ||
        // Refs pra loja origem — CSP block ou CORS.
        ORIGIN_STORE_HOSTS.test(href);
      if (shouldRemove) {
        $(el).remove();
        brokenPreloadsRemoved++;
      }
    });
    // 3.5.2. Remove <script src> + <link rel=stylesheet href> que apontam
    //        pra loja origem (residuais do clone que não têm CORS pra nós).
    //
    // INVARIANTE DE LOCALIDADE (2026-09-29):
    //   /cdn/shop/t/X/assets/*.css  → CSS do tema Shopify servido via CDN da loja.
    //                                  CORS-safe. NUNCA remover — são o styling do header,
    //                                  footer, FAQ, carousel. Remover causa regressão visual total.
    //   /cdn/shop/t/X/assets/*.js   → JS do tema (global.js, details-disclosure.js, etc).
    //                                  CORS-safe. NUNCA remover — acordeões, menus, FAQ nativo
    //                                  dependem deles. Remover quebra interatividade.
    //   /cdn/shopifycloud/*          → Shopify Pay / webmcp / runtime Shopify.
    //                                  Desnecessário no nosso storefront. Pode remover.
    //   /cdn/s/trekkie.*             → Tracking Shopify. Pode remover.
    //
    // Regra: só remove se NÃO é asset de tema (/cdn/shop/t/)
    const isThemeAsset = (url: string) => /\/cdn\/shop\/t\/\d+\/assets\//.test(url);

    let originStoreRefsRemoved = 0;
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (ORIGIN_STORE_HOSTS.test(href) && !isThemeAsset(href)) {
        $(el).remove();
        originStoreRefsRemoved++;
      }
    });
    $('script[src]').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (ORIGIN_STORE_HOSTS.test(src) && !isThemeAsset(src)) {
        $(el).remove();
        originStoreRefsRemoved++;
      }
    });

    if (
      brokenScriptsRemoved > 0 ||
      brokenPreloadsRemoved > 0 ||
      trackingPixelsRemoved > 0 ||
      brokenIframesRemoved > 0 ||
      originStoreRefsRemoved > 0
    ) {
      logger.info(
        {
          jobId: job.id,
          brokenScriptsRemoved,
          brokenPreloadsRemoved,
          trackingPixelsRemoved,
          brokenIframesRemoved,
          originStoreRefsRemoved,
        },
        'apply-bundle: removed broken runtime scripts and tracking',
      );
    }

    // 3.6. Theme asset recovery: clones criados via manual-paste (source_url=placeholder.local)
    // ou clones antigos podem não ter os <link rel="stylesheet"> e <script defer> do tema Shopify.
    // Sem esses assets: header, footer, FAQ, drawer ficam sem CSS/JS → layout quebrado.
    //
    // Detecção: se não há nenhum <link rel="stylesheet" href="*cdn/shop/t/*"> no HTML.
    // Recovery: busca um clone saudável da mesma store_id com theme assets presentes,
    // extrai os <link stylesheet cdn/shop/t/> e <script src cdn/shop/t/ defer> desse clone,
    // e injeta logo após o bloco @font-face no <head>.
    //
    // Idempotente: remove marcador data-landinglab-theme-recovery antes de reinjetar.
    $('[data-landinglab-theme-recovery]').remove();

    const hasThemeStylesheets = $('link[rel="stylesheet"]').toArray().some(el =>
      /\/cdn\/shop\/t\/\d+\/assets\//.test($(el).attr('href') || '')
    );

    // Página autocontida (CSS/JS próprios no storage): o tema de outra landing da loja mudaria o layout.
    const hasOwnAssets = hasRehostedLandingAssets(
      $('script[src], link[rel="stylesheet"][href]').toArray().map(el => $(el).attr('src') || $(el).attr('href') || ''),
    );

    let themeAssetsInjected = 0;
    if (!hasThemeStylesheets && !hasOwnAssets && page.storeId) {
      // Busca clone de referência: mesma store_id, tem theme assets, mais recente primeiro.
      const [refClone] = await db
        .select({ htmlBody: landingPages.htmlBody })
        .from(landingPages)
        .where(
          and(
            eq(landingPages.storeId, page.storeId),
            like(landingPages.htmlBody, '%cdn/shop/t/%'),
          )
        )
        .orderBy(desc(landingPages.updatedAt))
        .limit(1);

      if (refClone?.htmlBody) {
        const $ref = cheerio.load(refClone.htmlBody);

        // Coleta stylesheets do tema (preserva ordem original, reconstrói tag completa)
        const themeStylesheetTags: string[] = [];
        $ref('link[rel="stylesheet"]').each((_, el) => {
          const $el = $ref(el);
          const href = $el.attr('href') || '';
          if (/\/cdn\/shop\/t\/\d+\/assets\//.test(href)) {
            const rel = $el.attr('rel') || 'stylesheet';
            const type = $el.attr('type') ? ` type="${$el.attr('type')}"` : '';
            const media = $el.attr('media') ? ` media="${$el.attr('media')}"` : '';
            const onload = $el.attr('onload') ? ` onload="${$el.attr('onload')}"` : '';
            themeStylesheetTags.push(`<link href="${href}" rel="${rel}"${type}${media}${onload}>`);
          }
        });

        // Coleta scripts do tema com defer (globals, FAQ, drawer, etc.)
        const themeScriptTags: string[] = [];
        $ref('script[src][defer]').each((_, el) => {
          const src = $ref(el).attr('src') || '';
          if (/\/cdn\/shop\/t\/\d+\/assets\//.test(src)) {
            themeScriptTags.push(`<script src="${src}" defer="defer"></script>`);
          }
        });

        if (themeStylesheetTags.length > 0 || themeScriptTags.length > 0) {
          // Cheerio suporta .after() com HTML raw — insere os nodes após o elemento target.
          const recoveryMarker = `<meta data-landinglab-theme-recovery="1">`;
          const injectionBlock =
            recoveryMarker +
            themeStylesheetTags.join('\n') +
            '\n' +
            themeScriptTags.join('\n');

          // Injeta após o bloco <style> que contém @font-face (antes de outros links/scripts).
          // Se não encontrar, faz append no <head>.
          const fontFaceStyle = $('style').toArray().find(el =>
            ($(el).html() || '').includes('@font-face')
          );
          if (fontFaceStyle) {
            $(fontFaceStyle).after(injectionBlock);
          } else {
            $('head').append(injectionBlock);
          }

          themeAssetsInjected = themeStylesheetTags.length + themeScriptTags.length;
          logger.info(
            {
              jobId: job.id,
              landingPageId,
              refCloneStylesheets: themeStylesheetTags.length,
              refCloneScripts: themeScriptTags.length,
            },
            'apply-bundle: injected missing theme assets (recovery)',
          );
        }
      } else {
        logger.warn(
          { jobId: job.id, landingPageId, storeId: page.storeId },
          'apply-bundle: theme assets missing but no reference clone found for store',
        );
      }
    }

    // 4. Idempotência: remove marcadores/handler de execuções anteriores
    $('[data-landing-variant-id]').removeAttr('data-landing-variant-id');
    $('[data-landing-mirror-variant-id]').removeAttr('data-landing-mirror-variant-id');
    $('[data-landing-pixel-product-id]').removeAttr('data-landing-pixel-product-id');
    $('[data-landing-pixel-value]').removeAttr('data-landing-pixel-value');
    $('[data-landing-pixel-currency]').removeAttr('data-landing-pixel-currency');
    $('[data-landing-qty]').removeAttr('data-landing-qty');
    $('[data-landing-cta]').removeAttr('data-landing-cta');
    $('script[data-landinglab-checkout-handler]').remove();
    $('script[data-landinglab-asset-resurrector]').remove();
    // Legacy: script inline SEM marker que o package cloner injetou na primeira
    // clonagem. Detecta pelo conteúdo ("Não foi possível iniciar o pagamento"
    // ou "collectAttribution =") sem o marker que evita remoção acidental.
    $('script').each((_, el) => {
      const $el = $(el);
      // Nunca remove scripts com nossos markers oficiais (ja limpos acima).
      if ($el.attr('data-landinglab-checkout-handler') !== undefined) return;
      if ($el.attr('data-landinglab-asset-resurrector') !== undefined) return;
      if ($el.attr('data-landinglab-manual-carousel') !== undefined) return;
      if ($el.attr('data-landinglab-pixel') !== undefined) return;
      if ($el.attr('src')) return;
      const inner = $el.html() || '';
      if (
        /Não foi possível iniciar o pagamento|Erro de conexão\. Tente novamente/.test(inner) ||
        /var collectAttribution\s*=|function collectAttribution/.test(inner)
      ) {
        $el.remove();
      }
    });
    // Marcadores antigos do template padrão (bundle v1)
    $('style[data-landinglab-bundle-styles]').remove();
    $('div[data-landinglab-bundle="v1"]').remove();
    $('script[data-landinglab-bundle-runtime]').remove();

    // 4.98. FIX imagens Swiper brancas (slide 2+):
    //       Insight do usuário: primeira imagem carrega, próximas ficam brancas.
    //       Cada <img> tem SRCSET com múltiplas URLs (variantes por tamanho).
    //       Browser tenta URL do srcset — se falhar em algum edge CDN, fica
    //       branco sem fallback para src.
    //       Fix: REMOVE srcset de TODAS imagens Swiper. Browser só tem SRC.
    //       Se src funciona (imagem 1), TODAS as próximas também vão funcionar.
    let srcsetRemoved = 0;
    $('.swiper img[srcset], .cc-pdp__main-image[srcset], .cc-pdp__thumb-image[srcset]').each((_, el) => {
      $(el).removeAttr('srcset');
      $(el).removeAttr('sizes');
      // Se tem data-srcset também remove
      $(el).removeAttr('data-srcset');
      srcsetRemoved++;
    });
    if (srcsetRemoved > 0) {
      logger.info({ jobId: job.id, srcsetRemoved }, 'apply-bundle: removed srcset from Swiper imgs (fix white slides)');
    }

    // Também remove srcset de <source> dentro de <picture> nas mesmas galerias
    $('.swiper picture source, .cc-pdp__main-image + source, picture source').each((_, el) => {
      $(el).remove();
    });

    // 4.99. FIX IMAGENS SWIPER: preserva DOM (botoes funcionam) + CSS force
    //       garante slides visíveis mesmo se Swiper JS falhar.
    //
    //       Estratégia:
    //       1) Injeta Swiper.js CDN (jsDelivr) — funciona botões prev/next
    //       2) Injeta CSS que sobrescreve transform/opacity dos slides
    //          pra que TODAS imagens fiquem visíveis quando Swiper NÃO
    //          inicializou (fallback quando JS falha regionalmente).
    //       3) Reinit script como safety-net.
    //
    //       Vantagem: mantém DOM original, tabs/botões continuam funcionando.
    // 4.99. SOLUÇÃO FINAL: substitui Swiper por navegação manual JS puro.
    //       Swiper original quebrava imgs 2+ pra alguns usuários (opacity/transform
    //       do JS Swiper deve estar cachado stale, ou o browser tem CSS custom
    //       que quebra).
    //       Nova solução: JS puro que faz uma coisa só — quando clica em botão
    //       next/prev/thumb, MUDA O SRC da imagem visível. Sem transições,
    //       sem lazy load, sem framework, sem classes CSS.
    // 4.98.5. Timeline (Settimana): NÃO substituir src — as imagens originais
    //         do clone JÁ ESTÃO no Supabase (via downloader). Só força eager
    //         + remove srcset pra browser baixar imediatamente (não esperar
    //         Swiper posicionar).
    //
    // Nota: até 2026-09-19 esse bloco tinha URLs hardcoded (timeline-week1.webp
    // etc) que só funcionavam pra landing aurivita e41a3832 antiga. Removido.
    const timelineMediaImgs = $('.cc-timeline .cc-timeline__media img, .cc-timeline img.cc-timeline__image, .cc-timeline picture img');
    let timelineImgsReplaced = 0;
    timelineMediaImgs.each((_idx, img) => {
      const $img = $(img);
      $img.attr('loading', 'eager');
      $img.removeAttr('srcset');
      $img.removeAttr('sizes');
      $img.removeAttr('data-src');
      timelineImgsReplaced++;
    });
    // Remove <source> siblings dentro de <picture> — browser fica esperando
    // decidir qual srcset carregar; removendo, cai direto no <img src>.
    $('.cc-timeline picture source').remove();
    if (timelineImgsReplaced > 0) {
      logger.info({ jobId: job.id, timelineImgsReplaced }, 'apply-bundle: timeline imgs eager + no-srcset');
    }

    // 4.98.6. Doctors-see (Passo 1-4): força loading eager + remove srcset das imgs
    //         Também garante panel.is-active com display block para mostrar imagem.
    let doctorsSeeImgsFixed = 0;
    $('.cc-doctors-see img').each((_, img) => {
      const $img = $(img);
      $img.attr('loading', 'eager');
      $img.removeAttr('srcset');
      $img.removeAttr('sizes');
      $img.removeAttr('data-src');
      doctorsSeeImgsFixed++;
    });
    $('.cc-doctors-see picture source').remove();
    if (doctorsSeeImgsFixed > 0) {
      logger.info({ jobId: job.id, doctorsSeeImgsFixed }, 'apply-bundle: doctors-see imgs fixed (eager, no srcset)');
    }

    // 4.98.6.5. Legacy CSS cleanups: injetores anteriores forçavam altura fixa
    //           700px/780px no swiper de reviews (deixava cards ENORMES).
    //           Original aurivita.co usa altura variável ~286px. Remove todos
    //           os patterns "swiper ... max-height: 7XXpx" via string replace.
    let legacyReviewCssRemoved = 0;
    $('style').each((_, el) => {
      const raw = $(el).html() || '';
      if (!/\.swiper[^{]*\{[^}]*max-height:\s*7\d\dpx/i.test(raw) &&
          !/cc-customer-notice__swiper[^{]*\{[^}]*(?:max-)?height:\s*7\d\dpx/i.test(raw)) return;
      const cleaned = raw
        // Regra generica ".swiper .swiper-wrapper { max-height: 800px }"
        .replace(/\.swiper\s+\.swiper-wrapper\s*\{[^}]*max-height:\s*7\d\dpx[^}]*\}/gi, '')
        // Regra ".swiper .swiper-slide { max-height: 780px }"
        .replace(/\.swiper\s+\.swiper-slide\s*\{[^}]*max-height:\s*7\d\dpx[^}]*\}/gi, '')
        // Regra "cc-customer-notice__swiper ... { height: 700px }"
        .replace(/\.cc-customer-notice__swiper[^{]*\{[^}]*(?:max-)?height:\s*7\d\dpx[^}]*\}/gi, '');
      if (cleaned !== raw) {
        $(el).html(cleaned);
        legacyReviewCssRemoved++;
      }
    });
    if (legacyReviewCssRemoved > 0) {
      logger.info({ jobId: job.id, legacyReviewCssRemoved }, 'apply-bundle: removed legacy 700/780px review CSS');
    }
    // Injeta override redundante pra garantir altura auto mesmo se CSS externo
    // reintroduzir a regra
    $('style[data-landinglab-reviews-fix]').remove();
    $('head').append(`<style data-landinglab-reviews-fix>
.cc-customer-notice__swiper,
.cc-customer-notice__swiper .swiper-wrapper,
.cc-customer-notice__swiper .swiper-slide,
.cc-customer-notice__card{
  height:auto!important; max-height:none!important;
}

/* BUG-REVIEWS-SWIPER-MOBILE: Swiper.js instancia mas transform não muda
 * (bug interno, activeIndex avança mas CSS transform stuck em matrix(1,0,0,1,0,0)).
 * Slides 2 e 3 ficam invisíveis fora do viewport.
 *
 * Fix: converter pra scroll-snap CSS (funciona nativo iPhone Safari, sem JS).
 * - Container: overflow-x: scroll + snap x mandatory
 * - Slides: snap-align: center, largura fixa
 * - Kill transform Swiper que fica com matrix inválida
 */
@media (max-width: 768px){
  .cc-customer-notice__swiper{
    overflow-x: auto !important;
    overflow-y: visible !important;
    scroll-snap-type: x mandatory !important;
    -webkit-overflow-scrolling: touch !important;
    scroll-behavior: smooth !important;
    scrollbar-width: none !important;
    padding-right: 0 !important;
  }
  .cc-customer-notice__swiper::-webkit-scrollbar{ display: none !important; }
  .cc-customer-notice__swiper .swiper-wrapper{
    display: flex !important;
    flex-wrap: nowrap !important;
    transform: none !important;
    transition: none !important;
    overflow: visible !important;
    width: auto !important;
    gap: 12px !important;
  }
  .cc-customer-notice__swiper .swiper-slide{
    flex: 0 0 88% !important;
    width: 88% !important;
    max-width: 88% !important;
    scroll-snap-align: center !important;
    scroll-snap-stop: always !important;
    margin: 0 !important;
    transform: none !important;
  }
}
</style>`);

    // BUG-REVIEWS-SWIPER-MOBILE: killswitch pro Swiper.js — destruir instância
    // se existir, senão fica interferindo com scroll-snap CSS.
    $('script[data-landinglab-reviews-killswitch]').remove();
    $('body').append(`<script data-landinglab-reviews-killswitch>
(function(){
  function killReviewsSwiper(){
    if (window.innerWidth > 768) return;
    var sw = document.querySelector('.cc-customer-notice__swiper');
    if (!sw) return;
    // Destruir Swiper.js se instanciou (transform bug)
    if (sw.swiper && typeof sw.swiper.destroy === 'function') {
      try { sw.swiper.destroy(true, true); } catch(_) {}
    }
    // Reset transform inline caso ficou preso
    var wrapper = sw.querySelector('.swiper-wrapper');
    if (wrapper) {
      wrapper.style.transform = '';
      wrapper.style.transition = '';
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', killReviewsSwiper);
  } else {
    killReviewsSwiper();
  }
  // Re-run após 500ms caso Swiper inicialize tardio
  setTimeout(killReviewsSwiper, 500);
  setTimeout(killReviewsSwiper, 1500);
})();
</script>`);

    // 4.98.6.6. Fix &amp;nbsp; escapado em texto: alguns pipelines de tradução
    //           retornaram HTML entities encoded double (&nbsp; virou &amp;nbsp;).
    //           Aparece VISÍVEL como "&nbsp;Henry.W" em nomes de review, alt tags,
    //           etc. Fix: cheerio percorre TODOS os text nodes e reverte pra espaço.
    //           Também trata &amp;quot;, &amp;amp;, &amp;#39; comuns.
    let ampFixCount = 0;
    // Cheerio decoda &amp;nbsp; → &nbsp; no parse, e depois &nbsp; vira   (NBSP)
    // no textContent. Precisamos limpar AMBOS: escape duplo (raw) e NBSP prefixando
    // nome do autor (vem da tradução AI mal formada).
    // Cheerio parseia "&amp;nbsp;" (HTML source) → "&nbsp;" (7 chars literal) no
    // textNode.data. Precisamos limpar essa string LITERAL como aparece no
    // textContent, não a entity real (&nbsp; entity vira U+00A0).
    const ENTITY_MAP: Record<string, string> = {
      '&nbsp;': ' ',
      '&quot;': '"',
      '&#39;': "'",
      '&apos;': "'",
    };
    const $body = $('body');
    const walk = (el: any): void => {
      const $el = $(el);
      const contents = $el.contents();
      contents.each((_: number, node: any) => {
        if (node.type === 'text') {
          const orig = (node as { data: string }).data;
          let cleaned = orig;
          for (const [entity, replacement] of Object.entries(ENTITY_MAP)) {
            if (cleaned.includes(entity)) {
              cleaned = cleaned.split(entity).join(replacement);
              ampFixCount++;
            }
          }
          // NBSP (U+00A0) prefixando/sufixando texto real: geralmente vem da
          // tradução AI que colou "&nbsp;Name" — resulta em NBSP visível como
          // 1º char. Só limpa em text nodes CURTOS (<50 chars) pra não afetar
          // texto legítimo de reviews longos.
          if (cleaned.length < 50 && /^[\u00A0\s]+\S|\S[\u00A0\s]+$/.test(cleaned)) {
            const trimmed = cleaned.replace(/^[\u00A0\s]+/, '').replace(/[\u00A0\s]+$/, '');
            if (trimmed !== cleaned && trimmed.length > 0) {
              cleaned = trimmed;
              ampFixCount++;
            }
          }
          if (cleaned !== orig) {
            (node as { data: string }).data = cleaned;
          }
        } else if (node.type === 'tag') {
          walk(node);
        }
      });
    };
    $body.each((_, el) => walk(el));
    // Também limpa em atributos alt/title
    $('img[alt], [title], [aria-label]').each((_, el) => {
      const $el = $(el);
      for (const attr of ['alt', 'title', 'aria-label']) {
        const v = $el.attr(attr);
        if (!v) continue;
        let clean = v;
        for (const [entity, replacement] of Object.entries(ENTITY_MAP)) {
          clean = clean.split(entity).join(replacement);
        }
        if (clean !== v) {
          $el.attr(attr, clean);
          ampFixCount++;
        }
      }
    });
    if (ampFixCount > 0) {
      logger.info({ jobId: job.id, ampFixCount }, 'apply-bundle: fixed double-encoded HTML entities');
    }

    // 4.98.7. FIX ZOOM CULPADO: o tema aurivita tem CSS "@media (max-width:1600px)
    //         and (min-width:1400px) { body { zoom: 90%; } }" que quebra Swiper.js.
    //         getBoundingClientRect respeita zoom (retorna 695) mas offsetWidth NAO
    //         respeita (retorna 772) → Swiper mede errado, snap points ficam
    //         desalinhados. Fix: remove qualquer regra "body { zoom }" das <style>.
    let zoomRulesRemoved = 0;
    $('style').each((_, el) => {
      const txt = $(el).html() || '';
      if (!/body\s*\{[^}]*zoom\s*:/i.test(txt)) return;
      const cleaned = txt
        .replace(/body\s*\{[^}]*zoom\s*:\s*[^;}]+;?[^}]*\}/gi, '')
        .replace(/@media[^{]+\{\s*\}/g, '');
      if (cleaned !== txt) {
        $(el).html(cleaned);
        zoomRulesRemoved++;
      }
    });
    if (zoomRulesRemoved > 0) {
      logger.info({ jobId: job.id, zoomRulesRemoved }, 'apply-bundle: removed body zoom rules');
    }
    $('style[data-landinglab-nozoom]').remove();
    $('head').append('<style data-landinglab-nozoom>html,body{zoom:1!important}</style>');

    // BUG-IPHONE-BLACK-BAND: checkout-handler-injector setava
    // "html, body { overflow: auto !important; overflow-y: auto !important }"
    // dentro de <style id="ll-popup-kill"> pra desbloquear Klaviyo body lock.
    // Isso trava html em height:100% (viewport) + cria double-scrollbar, o
    // que gera FAIXA PRETA gigante no iPhone Safari real após seções coloridas.
    // Fix: reescrever a regra pra ser só body scroll, html com overflow visible.
    let popupKillPatched = 0;
    $('style#ll-popup-kill, style[id="ll-popup-kill"]').each((_, el) => {
      const txt = $(el).html() || '';
      if (!/html\s*,\s*body\s*\{[^}]*overflow\s*:\s*auto/i.test(txt)) return;
      const cleaned = txt.replace(
        /html\s*,\s*body\s*\{[^}]*overflow[^}]*\}/gi,
        'html { overflow-x: hidden !important; overflow-y: visible !important; } body { overflow-x: hidden !important; overflow-y: auto !important; }'
      );
      if (cleaned !== txt) {
        $(el).html(cleaned);
        popupKillPatched++;
      }
    });
    if (popupKillPatched > 0) {
      logger.info({ jobId: job.id, popupKillPatched }, 'apply-bundle: patched popup-kill overflow rule (iPhone black band fix)');
    }

    // BUG-IPHONE-BLACK-BAND v5 (nuclear): meta theme-color + CSS FORA de @media
    // Injetar no head PRIMEIRO CSS que iOS Safari SEMPRE respeita:
    //   - meta name="theme-color" define bg do webview + status bar
    //   - CSS não-media (aplica desktop + mobile): elimina qualquer bg preto/vazio
    $('meta[name="theme-color"]').remove();
    $('head').prepend(`<meta name="theme-color" content="#f8f2f2">`);

    $('style[data-landinglab-ios-safari-bg]').remove();
    $('head').append(`<style data-landinglab-ios-safari-bg>
/* iOS Safari: garantir que NUNCA aparece bg preto default do webview em NENHUMA
 * transição entre seções. Aplicado universalmente (não @media). */
html { background: #f8f2f2 !important; background-color: #f8f2f2 !important; }
body { background: #f8f2f2 !important; background-color: #f8f2f2 !important; }
main, main.content-for-layout {
  background: #f8f2f2 !important; background-color: #f8f2f2 !important;
}
.shopify-section, div.shopify-section, section.shopify-section {
  background-color: transparent !important;
}
/* O HTML clonado não tem <!doctype>, então o navegador usa BackCompat e
 * document.scrollingElement é BODY. Deixar html com overflow-y:auto e body
 * com overflow-x:hidden/overflow-y:visible calcula auto nos DOIS elementos;
 * no celular a rolagem trava e pode aparecer uma tela preta. */
html {
  overflow-y: visible !important;
  overflow-x: visible !important;
  overscroll-behavior-y: contain !important;
  overscroll-behavior-x: contain !important;
}
body {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  overscroll-behavior: auto !important;
  -webkit-overflow-scrolling: touch !important;
  position: static !important;
  padding-top: 0 !important;
  padding-bottom: env(safe-area-inset-bottom, 0) !important;
}
/* Klaviyo body lock: garantir override total */
body.klaviyo-prevent-body-scrolling,
body[class*="klaviyo-prevent"] {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  position: static !important;
  padding-right: 0 !important;
  height: auto !important;
}

/* BUG-IPHONE-BLACK-BAND v6 (REAL FIX): tema Shopify usa img wrappers com bg
 * escuro #f1e7e3 + aspect-ratio + height:100% que EXPLODE em altura quando
 * imagem é lazy e demora pra carregar em 4G iPhone. O bg escuro parece PRETO
 * gigante ocupando quase 100% da tela. Confirmado via print do usuário
 * (2026-09-20 19:41 iPhone real 4G).
 *
 * Fix cirúrgico:
 *  - Wraps de imagem com bg TRANSPARENTE (não escuro)
 *  - height: auto (não 100%) — respeita aspect-ratio sem explodir
 *  - loading eager em cc-cis (imagem hero da narrativa)
 *  - object-fit: cover mantém proporção */
.cc-cis__image-wrap,
[class*="cc-cis__image-wrap"],
.cc-pdp__main-video,
[class*="__image-wrap"],
[class*="__media-wrap"] {
  background: transparent !important;
  background-color: transparent !important;
}
.cc-cis__image,
.cc-cis__image-placeholder,
[class*="cc-cis__image"] {
  height: auto !important;
  max-height: 400px !important;
  aspect-ratio: 16 / 9 !important;
  object-fit: cover !important;
  width: 100% !important;
}
</style>`);

    // BUG-IPHONE-BLACK-BAND v6: forçar loading=eager nas imagens de cc-cis
    // pra que carreguem imediatamente (não lazy que demora no 4G do iPhone).
    let heroImgsEager = 0;
    $('.cc-cis__image, [class*="cc-cis__image"], .cc-expert-quote__image, .cc-faq__image').each((_, el) => {
      const $el = $(el);
      if ($el.attr('loading') === 'lazy') {
        $el.attr('loading', 'eager');
        $el.attr('fetchpriority', 'high');
        heroImgsEager++;
      }
    });
    if (heroImgsEager > 0) {
      logger.info({ jobId: job.id, heroImgsEager }, 'apply-bundle: hero imgs eager loading (iPhone black band fix v6)');
    }

    // ── Mobile fixes universais ──
    // Impede overflow horizontal de carrosséis internos + botões que não quebram linha.
    // Aplica em TODAS landings (mobile <= 768px) — evita cards laterais e horizontal scroll.
    $('style[data-landinglab-mobile-fix]').remove();
    $('head').append(`<style data-landinglab-mobile-fix>
/* Mobile fixes cirúrgicos — targeta APENAS bugs específicos identificados
 * em audit lado-a-lado com landing original. Não força layout universal. */
@media (max-width: 768px){
  /* BackCompat: body é o scrollingElement; html deve ficar visible. */
  html, body {
    max-width: 100vw !important;
    height: auto !important;
    min-height: 100% !important;
  }
  html { overflow-x: visible !important; overflow-y: visible !important; }
  body { overflow-x: hidden !important; overflow-y: auto !important; }
  /* BUG-BLACKGAP v4 (nuclear): forçar bg bege TAMBÉM em .cc-cis__section
   * (rosa claro) transição pra .cc-how-it-works__section (branco). Usuário
   * reporta faixa preta só no iPhone real após cc-cis. Suspeita: seção
   * pai (.shopify-section) do tema, que envolve cada bloco, pode ter bg
   * transparente entre elas.
   *
   * Fix nuclear:
   *  - Todas .shopify-section com bg explícito bege
   *  - html/body bege consistente
   *  - overscroll-behavior none */
  html, body {
    background: #f8f2f2 !important;
    background-color: #f8f2f2 !important;
    overscroll-behavior-y: none !important;
    overscroll-behavior-x: none !important;
  }
  /* CRÍTICO: shopify-section wrappers sem bg deixam vazar html/body preto no iOS.
   * Forçar bg herdando de contexto (transparent = herda do parent que é bege). */
  main, main > section, main > div, .shopify-section, body > main {
    background-color: transparent !important;
  }
  /* main tem que ter bg bege pra que .shopify-section transparentes não vazem preto */
  main.content-for-layout, main {
    background: #f8f2f2 !important;
    background-color: #f8f2f2 !important;
  }

  /* Carrosséis com slides que fisicamente estouram: contêiner clip */
  .aurivita-stats,
  .avs__mobile-track,
  .cc-benefits-marquee,
  [class*="__marquee"]{
    max-width: 100vw !important;
    overflow-x: hidden !important;
  }

  /* Botões PDP com white-space nowrap que estouram */
  .cc-pdp-progress__button{
    white-space: normal !important;
    max-width: 100% !important;
  }

  /* BUG-05: hero e cards laterais devem ter mesma altura, não espremidos.
   * Original mobile mostra imagem grande (~1/1 aspect) sem badges laterais.
   * Escondemos badges no mobile — só ficam desktop. */
  .cc-pdp__main-column .cc-pdp__badges,
  .cc-pdp__gallery-layout .cc-pdp__extra-column{
    display: none !important;
  }
  .cc-pdp__gallery-layout{
    grid-template-columns: 1fr !important;
  }
  .cc-pdp__media-col,
  .cc-pdp__main-column{
    width: 100% !important;
    max-width: 100% !important;
  }

  /* BUG-11: reviews slider — cards não devem ter preview cortado feio.
   * Padding lateral pra dar respiro ao card seguinte. */
  .cc-customer-notice__swiper{
    padding-right: 24px !important;
    box-sizing: border-box;
  }

  /* BUG-ADV-01: estatísticas 84%/79%/76%/71% em 4 colunas quebram palavras.
   * Força 2x2 grid em mobile pra respirar (147px→175px por card). */
  gp-row.gp-grid[data-mobile-cols="4"],
  gp-row.gp-grid[class*="gp-grid"][style*="grid-template-columns"][style*="fr fr fr fr"],
  gp-row.gzczjsRhKh,
  gp-row.gGUAozHtSp,
  gp-row.gIo9zaQiBa,
  gp-row.gBEbVbz-1s{
    grid-template-columns: 1fr 1fr !important;
    gap: 16px !important;
  }
  /* Evitar quebra de palavras em spans/parágrafos das estatísticas */
  gp-row.gp-grid p,
  gp-row.gp-grid span,
  gp-row.gp-grid strong{
    overflow-wrap: normal !important;
    word-break: normal !important;
    hyphens: none !important;
  }

  /* BUG-ADV-05: setas do carousel reviews sobrepostas ao texto */
  [class*="gem-slider"] [class*="arrow"],
  [class*="gem-slider"] [class*="prev"],
  [class*="gem-slider"] [class*="next"]{
    top: auto !important;
    bottom: -40px !important;
    transform: none !important;
    background: rgba(255,255,255,0.9) !important;
  }

  /* BUG-ADV-MOBILE (audit iPhone 19:56 prints): gp-row com background-image
   * cover cria seções gigantes 900-1200px, imagens ficando cortadas/distorcidas.
   * Também: gp-container em 2-col fica com cada imagem em coluna estreita
   * gerando visual em "colunas verticais" (fábrica esquerda + mão direita).
   *
   * Fix mobile:
   *  1. gp-row com bg-image: limitar altura, background-size: cover mantém proporção
   *  2. gp-container 2-col vira 1-col empilhada (padrão mobile)
   *  3. Imagens em gp-row: max-height 400px, object-fit cover
   *  4. Text overlays não podem colar contra bg — padding uniforme
   */
  gp-row[style*="background-image"],
  gp-row.gp-grid[style*="background-image"],
  gp-row[class*="gp-grid"]{
    background-size: cover !important;
    background-repeat: no-repeat !important;
    background-position: center !important;
  }
  /* Limitar altura de gp-row com bg em mobile (impede tela cheia) */
  gp-row.gp-grid{
    min-height: auto !important;
  }
  /* Force gp-container 2-col → 1-col stack no mobile */
  gp-container[class*="grid-cols-2"],
  gp-container[class*="grid-cols-3"],
  gp-container[class*="grid-cols-4"],
  gp-container[style*="grid-template-columns"]:not([style*="1fr"]:not([style*="1fr 1fr"])){
    grid-template-columns: 1fr !important;
    display: block !important;
  }
  gp-container > *{ width: 100% !important; }

  /* BUG-ADV-MOBILE v2: seletores CORRETOS pra imagens GemPages advertorial.
   * <img> NÃO tem classe gp-image — tem gp-inline-block.gp-w-full.
   * Wrapper NÃO é <gp-image> — é <div class="gp-group/image"> (com barra).
   *
   * Ataca via múltiplos seletores + CSS variables --h-mobile que gempages usa:
   */
  /* Imagens direto: hard limit de altura mobile independente do que gempages faz */
  img.gp-inline-block,
  img.gp-w-full,
  img[class*="gp-w-full"],
  img[class*="gp-inline-block"],
  picture > img,
  .gp-group\\/image img,
  [class*="gp-group"] img{
    max-height: 320px !important;
    height: auto !important;
    width: 100% !important;
    object-fit: cover !important;
    object-position: center !important;
  }
  /* Wrappers de imagem GemPages: limitar altura E deixar imagem responsiva */
  .gp-group\\/image,
  [class*="gp-group"][class*="image"],
  div.gp-h-full.gp-w-full.gp-flex{
    max-height: 320px !important;
    height: auto !important;
    overflow: hidden !important;
  }
  /* GemPages CSS vars: --h-mobile força altura mobile — kill */
  gp-image, gp-container, [class*="gp-image"], gp-row *{
    --h-mobile: auto !important;
    --h-tablet: auto !important;
    --h: auto !important;
  }
  /* gp-row filho gigante 1161px (imagem cover): limitar em mobile */
  gp-row.gp-grid > div[class*="gp-relative"],
  gp-row.gp-grid > div[class*="gp-flex-col"]{
    max-height: none !important;
    min-height: auto !important;
  }
  /* Imagens quadradas (aspect 1:1 esticadas): forçar aspect nativo respeitado */
  img[width="100%"]{ width: 100% !important; height: auto !important; }
  /* PICTURE tags (parent="contents" quebra layout iOS): forçar block */
  picture.gp-contents{ display: block !important; }

  /* Text-instant blocks com bg-image: limitar altura pra texto ficar legível */
  div.gp-text-instant, .gp-text-instant.gp-text{
    max-height: none !important;
    min-height: auto !important;
  }

  /* Espaço entre strong e regular no mesmo parágrafo (bug prints stats:
   * "maggiore**sicurezza**riguardo" sem espaço) */
  gp-row.gp-grid p strong,
  gp-row.gp-grid div strong,
  gp-container p strong{
    margin-right: 0.15em !important;
    margin-left: 0.15em !important;
  }

  /* Títulos gp-heading: line-height + padding pra não cortar em cima/embaixo */
  gp-heading, [class*="gp-heading"], gp-container h1, gp-container h2, gp-container h3{
    line-height: 1.15 !important;
    padding-top: 4px !important;
    padding-bottom: 4px !important;
    overflow: visible !important;
  }

  /* Footer logo (Aurivit): garantir z-index baixo pra não sobrepor links */
  footer img[src*="logo"], footer [class*="logo"] img,
  gp-container[class*="footer"] img[src*="aurivit"],
  .cc-footer__logo img{
    max-height: 60px !important;
    width: auto !important;
    max-width: 200px !important;
    position: relative !important;
    z-index: 1 !important;
  }
  /* Footer links sempre visíveis (z-index alto) */
  footer a, footer nav, .cc-footer__menu-list{
    position: relative !important;
    z-index: 2 !important;
  }

  /* BUG-08: tabela comparativa AVS — swipe suave com snap points */
  .avs__mobile-track{
    scroll-snap-type: x mandatory !important;
    scroll-behavior: smooth !important;
    padding-left: 16px !important;
    padding-right: 16px !important;
  }
  .avs__card--mobile{
    scroll-snap-align: center !important;
    flex-shrink: 0 !important;
  }
  /* AVS indicador de swipe: adicionar dots visual */
  .avs__dots, .avs__pagination{
    display: flex !important;
    justify-content: center !important;
    gap: 6px !important;
    margin-top: 12px !important;
  }

  /* BUG-P4 (real iPhone): .cc-how-to-take__card usa grid 126px 225px que
   * espreme a imagem em faixa vertical de 126px de largura. Em mobile forçar
   * 1 coluna vertical — imagem em cima (full width), texto embaixo. */
  .cc-how-to-take__card{
    display: block !important;
    grid-template-columns: none !important;
  }
  .cc-how-to-take__media{
    width: 100% !important;
    height: auto !important;
    aspect-ratio: 16/9 !important;
    max-height: 240px !important;
    overflow: hidden !important;
  }
  .cc-how-to-take__media img,
  .cc-how-to-take__media picture{
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
    object-position: center !important;
  }
  .cc-how-to-take__content{
    padding: 16px !important;
  }

  /* BUG-P1 (real iPhone): CTA "Aggiungi al Carrello €39.98€135.00" com
   * white-space nowrap sai da tela em iPhone real. Força wrap + shrink. */
  button[class*="cc-pdp-cta"],
  button[class*="atc-button"],
  .main-atc,
  button.product-form__submit{
    white-space: normal !important;
    flex-wrap: wrap !important;
    padding: 12px 16px !important;
    font-size: 15px !important;
  }
  button[class*="cc-pdp-cta"] span,
  button[class*="atc-button"] span,
  .main-atc span{
    white-space: normal !important;
    word-break: normal !important;
  }
  [data-cc-atc-append]{
    flex-wrap: wrap !important;
    justify-content: center !important;
  }

  /* BUG-CTA-LAYOUT (print 20:24): CTA fica com "Aggiungi Al Carrello" em 2
   * linhas do lado esquerdo, gap enorme no meio, preços empilhados direita.
   * Root cause: .main-atc__label é flex-direction:row com 2 filhos (label +
   * preços) que somam 323px em iPhone 393px → force wrap ugly.
   *
   * Fix: flex-direction column empilha vertical E centraliza. Preços ficam
   * ABAIXO do texto ao invés de brigar por espaço horizontal.
   *
   * SPECIFICITY WAR: tema tem regra com ID (#cc-pdp-complete-...) que ganha,
   * então usamos [id*="cc-pdp-complete"] + BODY pra bater especificidade. */
  html body [id^="cc-pdp-complete-"] .cc-pdp-buy-buttons .main-atc__label,
  html body [id^="cc-pdp-complete-"] .cc-pdp-buy-buttons .button__label,
  html body [id^="cc-pdp-complete-"] .cc-pdp-buy-buttons [id^="ProductSubmitButton-"] .main-atc__label,
  html body [id^="cc-pdp-complete-"] .cc-pdp-buy-buttons [id^="ProductSubmitButton-"] .button__label,
  body .cc-pdp-buy-buttons .main-atc__label,
  body .cc-pdp-buy-buttons .button__label,
  .main-atc__label, .button__label {
    flex-direction: column !important;
    gap: 6px !important;
    align-items: center !important;
    justify-content: center !important;
    width: 100% !important;
    text-align: center !important;
  }
  .main-atc__label__text, .buybtn1 {
    font-size: 16px !important;
    font-weight: 700 !important;
    line-height: 1.2 !important;
    text-align: center !important;
  }
  [data-cc-atc-append] {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 8px !important;
    margin-left: 0 !important;
    font-size: 18px !important;
  }
  [data-cc-atc-append] span {
    font-size: 16px !important;
  }
  /* Hide o separador "·" quando preços em nova linha (fica feio "· €39.98") */
  [data-cc-atc-append] > span[aria-hidden="true"]:first-child {
    display: none !important;
  }
  /* Garantee row: full width + centralized abaixo do label */
  [data-cc-atc-guarantee], .cc-pdp-atc-guarantee {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 6px !important;
    width: 100% !important;
    margin-top: 8px !important;
    padding: 6px 0 !important;
    font-size: 13px !important;
    text-align: center !important;
  }

  /* BUG-M1 (audit full): .aurivita-stats__number 44px quebra texto ("Piccoli
   * vas i sanguigni"). Em mobile forçar 28px + line-height compacto.
   * Também tratar variação com class similar. */
  .aurivita-stats__number,
  [class*="aurivita-stats__number"],
  .aurivita-stats h1, .aurivita-stats h2, .aurivita-stats h3{
    font-size: 28px !important;
    line-height: 1.15 !important;
    word-break: normal !important;
    hyphens: none !important;
  }
  .aurivita-stats__label,
  .aurivita-stats p{
    font-size: 14px !important;
    line-height: 1.4 !important;
  }

  /* BUG-M3 (audit full): AVS mobile grid label muito comprimido (86px)
   * — "Via metabolica" quebra. Aumentar label pra 110px, reduzir fonte. */
  .avs__mobile-grid{
    grid-template-columns: 110px 1fr !important;
    gap: 8px !important;
  }
  .avs__mobile-grid > *:nth-child(odd),
  .avs__label{
    font-size: 12px !important;
    line-height: 1.25 !important;
    word-break: normal !important;
  }
  .avs__mobile-grid > *:nth-child(even),
  .avs__value{
    font-size: 13px !important;
    line-height: 1.35 !important;
  }
}

/* BUG-04: STICKY buy bar no mobile — usa o botão CTA principal (data-landing-cta=buy)
 * como sticky na parte de baixo. Só ativa em mobile. */
@media (max-width: 768px){
  .cc-pdp__pricing-offers[data-landinglab-sticky-clone] {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: rgba(255,255,255,0.98);
    box-shadow: 0 -2px 12px rgba(0,0,0,0.15);
    padding: 8px 16px;
    z-index: 999;
    display: none;
  }
  body.ll-sticky-visible .cc-pdp__pricing-offers[data-landinglab-sticky-clone] {
    display: block;
  }
}
</style>`);

    // BUG-04: injetar script sticky buy bar
    $('script[data-landinglab-sticky-buy]').remove();
    $('body').append(`<script data-landinglab-sticky-buy>(function(){
  function initSticky(){
    var trigger = document.querySelector('.cc-pdp__cta-wrap, [data-landing-cta="buy"]');
    if (!trigger) return;
    function onScroll(){
      var rect = trigger.getBoundingClientRect();
      // Mostra sticky quando o botão original está fora da tela (acima ou abaixo)
      var visible = rect.bottom < 0 || rect.top > window.innerHeight;
      document.body.classList.toggle('ll-sticky-visible', visible);
    }
    window.addEventListener('scroll', onScroll, {passive: true});
    onScroll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSticky);
  else initSticky();
})();</script>`);

    // SCROLL FIX: libera o body quando Klaviyo aplicar um lock de rolagem.
    // O observer não pode observar as próprias alterações: isso cria uma fila
    // infinita de microtasks e impede DOMContentLoaded/renderização da landing.
    $('script[data-landinglab-scroll-fix]').remove();
    $('body').append(`<script data-landinglab-scroll-fix>
(function(){
  var observer;
  function observeScrollLocks(){
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  }
  function unlockScroll(){
    var body = document.body;
    if (!body) return;
    var html = document.documentElement;
    var locked = body.classList.contains('klaviyo-prevent-body-scrolling') ||
      body.classList.contains('kl_reviews__modal_open') ||
      body.style.overflow === 'hidden' || body.style.position === 'fixed' ||
      !!body.style.paddingRight || !!body.style.top || html.style.overflow === 'hidden';
    if (!locked) return;
    // Descarta as mutações geradas pelo próprio desbloqueio.
    observer.disconnect();
    if (body.classList.contains('klaviyo-prevent-body-scrolling')) body.classList.remove('klaviyo-prevent-body-scrolling');
    if (body.classList.contains('kl_reviews__modal_open')) body.classList.remove('kl_reviews__modal_open');
    if (body.style.overflow === 'hidden') body.style.overflow = '';
    if (body.style.position === 'fixed') body.style.position = '';
    if (body.style.paddingRight) body.style.paddingRight = '';
    if (body.style.top) body.style.top = '';
    if (html.style.overflow === 'hidden') html.style.overflow = '';
    observeScrollLocks();
  }
  observer = new MutationObserver(unlockScroll);
  unlockScroll();
  observeScrollLocks();
})();
</script>`);

    // BUG-CTA-LAYOUT-INLINE: tema tem regra com ID que vence qualquer CSS externo
    // com classes/attrs. Solução: injetar style="flex-direction: column"
    // INLINE no elemento — vence TUDO em mobile (via <script> viewport check).
    $('script[data-landinglab-cta-inline-fix]').remove();
    $('body').append(`<script data-landinglab-cta-inline-fix>
(function(){
  function applyCta(){
    if (window.innerWidth > 768) return;
    var labels = document.querySelectorAll('.main-atc__label, .button__label');
    labels.forEach(function(label){
      label.style.setProperty('flex-direction', 'column', 'important');
      label.style.setProperty('gap', '6px', 'important');
      label.style.setProperty('align-items', 'center', 'important');
      label.style.setProperty('justify-content', 'center', 'important');
      label.style.setProperty('width', '100%', 'important');
      label.style.setProperty('text-align', 'center', 'important');
    });
    // Also hide the separator "·" child span aria-hidden
    var sepSpans = document.querySelectorAll('[data-cc-atc-append] > span[aria-hidden="true"]:first-child');
    sepSpans.forEach(function(s){ s.style.setProperty('display', 'none', 'important'); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyCta);
  else applyCta();
  setTimeout(applyCta, 100);
  setTimeout(applyCta, 500);
  setTimeout(applyCta, 1500);
  window.addEventListener('resize', applyCta);
})();
</script>`);

    // PERF-1 (Italia 4G): preconnect + dns-prefetch dos hosts críticos.
    // Reduz round-trip DNS+TLS em ~200-400ms cada. Aplica em landings novas.
    const preconnectHosts = [
      'https://cdn.shopify.com',
      'https://aurivita.co',
      ...(process.env['SUPABASE_URL'] ? [process.env['SUPABASE_URL'].replace(/\/$/, '')] : []),
      'https://fonts.gstatic.com',
      'https://connect.facebook.net',
      'https://www.facebook.com',
    ];
    // Remove versões antigas primeiro
    $('link[data-landinglab-preconnect]').remove();
    for (const host of preconnectHosts) {
      $('head').prepend(`<link rel="preconnect" href="${host}" crossorigin data-landinglab-preconnect>`);
      $('head').prepend(`<link rel="dns-prefetch" href="${host}" data-landinglab-preconnect>`);
    }

    // PERF-2: preload hero image (LCP element) — só a imagem PRINCIPAL da PDP.
    // No print + audit, hero é .cc-pdp__main-image do primeiro slide ativo.
    const heroImg = $('.cc-pdp__main-image, .cc-pdp__gallery-layout img, [class*="cc-pdp__main"] img').first();
    const heroSrc = heroImg.attr('src');
    if (heroSrc) {
      $('link[data-landinglab-preload-hero]').remove();
      $('head').prepend(`<link rel="preload" as="image" href="${heroSrc}" fetchpriority="high" data-landinglab-preload-hero>`);
    }

    // PERF-3: adicionar loading=lazy em TODAS imagens abaixo do fold (não hero).
    // Reduz TTI + FCP em 4G. Idempotente — só adiciona se não tem.
    let lazyAdded = 0;
    $('img').each((_, el) => {
      const $el = $(el);
      if ($el.attr('loading')) return; // já tem eager ou lazy
      // Não lazy pra hero + logo + acima do fold
      const cls = ($el.attr('class') || '').toLowerCase();
      if (cls.includes('cc-pdp__main') || cls.includes('cc-header') || cls.includes('logo')) return;
      $el.attr('loading', 'lazy');
      $el.attr('decoding', 'async');
      lazyAdded++;
    });
    if (lazyAdded > 0) {
      logger.info({ jobId: job.id, lazyAdded }, 'apply-bundle: added loading=lazy to below-fold images (perf)');
    }

    // BUG-CAROUSEL-ARROWS: remove classes Swiper.js que travam botões no HTML.
    // Essas classes vêm do template Shopify quando Swiper.js falha em inicializar
    // corretamente e marca botões como "disabled/lock" mesmo com 5 slides.
    let carouselBtnsUnlocked = 0;
    $('.cc-pdp__main-arrow, [class*="cc-pdp__main-arrow"], button[class*="main-arrow"]').each((_, el) => {
      const $el = $(el);
      let changed = false;
      if ($el.hasClass('swiper-button-disabled')) { $el.removeClass('swiper-button-disabled'); changed = true; }
      if ($el.hasClass('swiper-button-lock')) { $el.removeClass('swiper-button-lock'); changed = true; }
      if ($el.attr('disabled')) { $el.removeAttr('disabled'); changed = true; }
      if ($el.attr('aria-disabled') === 'true') { $el.attr('aria-disabled', 'false'); changed = true; }
      if ($el.attr('tabindex') === '-1') { $el.removeAttr('tabindex'); changed = true; }
      if (changed) carouselBtnsUnlocked++;
    });
    if (carouselBtnsUnlocked > 0) {
      logger.info({ jobId: job.id, carouselBtnsUnlocked }, 'apply-bundle: unlocked product carousel arrows (swiper-button-disabled)');
    }

    // Idempotência: remove versões antigas do CSS antes de reinjetar
    $('style[data-landinglab-manual-carousel-css]').remove();
    $('script[data-landinglab-manual-carousel]').remove();
    if (true) {
      $('head').append(`<style data-landinglab-manual-carousel-css>
/* Tabpanels: quando is-active, força display e imgs eager.
 * IMPORTANTE: seletor precisa ser específico (não [class*="__detail"] que casa com
 * .cc-timeline__details wrapper). Usamos .cc-timeline__detail (single) só. */
.cc-doctors-see [role="tabpanel"],
.cc-doctors-see .cc-doctors-see__panel,
.cc-timeline [role="tabpanel"],
.cc-timeline__detail{
  display:none;
}
.cc-doctors-see [role="tabpanel"].is-active,
.cc-doctors-see .cc-doctors-see__panel.is-active,
.cc-timeline [role="tabpanel"].is-active,
.cc-timeline__detail.is-active{
  display:flex!important;
  opacity:1!important;
  visibility:visible!important;
}
/* WRAPPER dos details NUNCA pode ser display:none — só os filhos individuais */
.cc-timeline__details, .cc-doctors-see__panels{
  display:block!important;
}
.cc-doctors-see [role="tabpanel"].is-active img,
.cc-doctors-see .cc-doctors-see__panel.is-active img,
.cc-timeline [role="tabpanel"].is-active img,
.cc-timeline__detail.is-active img{
  opacity:1!important;
  visibility:visible!important;
  display:block!important;
  max-width:100%!important;
  height:auto!important;
}
/* TIMELINE: Swiper.js real fica no comando. Nao mexemos com transform/position.
   Click handler chama swiperEl.swiper.slideTo(idx) que reposiciona translateX
   e o slide correto aparece na janela. Apenas garantimos que a img renderize. */
.cc-timeline__swiper .swiper-slide img,
.cc-timeline__swiper .swiper-slide picture,
.cc-timeline__swiper .swiper-slide .cc-timeline__media{
  display:block!important;
  opacity:1!important;
  visibility:visible!important;
  max-width:100%!important;
  height:auto!important;
}
/* Reviews/testimonials: avatar deve respeitar width attribute */
.cc-customer-notice__author-avatar,
.cc-customer-notice__author-row img,
[class*="review"] [class*="avatar"] img,
[class*="testimonial"] [class*="avatar"] img,
img.cc-customer-notice__author-avatar{
  width:40px!important;
  height:40px!important;
  max-width:40px!important;
  max-height:40px!important;
  border-radius:50%!important;
  object-fit:cover!important;
  display:inline-block!important;
}
/* Product image thumbnails nos reviews footer */
.cc-customer-notice__product-image-wrap img,
.cc-customer-notice__product-image{
  width:48px!important;
  height:48px!important;
  max-width:48px!important;
  border-radius:6px!important;
  object-fit:cover!important;
}
/* CAROUSEL MANUAL: aplica ESPECIFICAMENTE em galeria produto principal.
   NAO usa selector generico .swiper-slide img pra nao ampliar avatares
   de reviews que tambem estao em swipers. */
.cc-pdp__main-image,
.cc-pdp__main .cc-pdp__main-slide img,
.cc-pdp__main .swiper-slide > img{
  opacity:1!important;
  visibility:visible!important;
  display:block!important;
  width:100%!important;
  height:auto!important;
  max-width:100%!important;
}
/* Container: overflow visivel pra nao clipar */
.cc-pdp__main-wrap,.cc-pdp__main-column,.cc-pdp__gallery-layout{overflow:visible!important}
/* Thumbs container: mostra todas empilhadas verticalmente */
.cc-pdp__thumbs-wrap .swiper-wrapper{
  display:flex!important;
  flex-direction:column!important;
  gap:8px!important;
  transform:none!important;
  height:auto!important;
}
.cc-pdp__thumbs .swiper-slide{
  width:99px!important;
  height:99px!important;
  transform:none!important;
  opacity:1!important;
  cursor:pointer;
}
.cc-pdp__thumbs .swiper-slide img{
  width:99px!important;
  height:99px!important;
  object-fit:cover!important;
  border-radius:8px;
}
.cc-pdp__thumbs .swiper-slide.ll-active-thumb{
  outline:2px solid #9f0004;
  outline-offset:2px;
}
/* Main slides: soh ativo visivel */
.cc-pdp__main .swiper-wrapper{transform:none!important;height:auto!important}
.cc-pdp__main > .swiper-wrapper > .swiper-slide,
.cc-pdp__main .cc-pdp__main-slide{
  width:100%!important;
  height:auto!important;
  transform:none!important;
  opacity:1!important;
  display:none!important;
}
.cc-pdp__main > .swiper-wrapper > .swiper-slide.ll-active-main,
.cc-pdp__main .cc-pdp__main-slide.ll-active-main{display:block!important}

/* BUG-CAROUSEL-ARROWS: Swiper.js marca botões prev/next como swiper-button-disabled
 * + swiper-button-lock quando acha que só tem 1 slide (bug do slide clone process).
 * Isso aplica opacity: 0.35-0.45 + pointer-events: none + display: none, fazendo
 * botão parecer desabilitado E impedindo tap no iPhone real. Fix: override CSS
 * com specificidade alta pra forçar habilitado. */
.cc-pdp__main-arrow,
.cc-pdp__main-arrow.swiper-button-disabled,
.cc-pdp__main-arrow.swiper-button-lock,
.cc-pdp__main-arrow--prev,
.cc-pdp__main-arrow--next,
[class*="cc-pdp__main-arrow"].swiper-button-disabled,
[class*="cc-pdp__main-arrow"].swiper-button-lock,
button[class*="main-arrow"]{
  opacity: 1 !important;
  pointer-events: auto !important;
  cursor: pointer !important;
  display: flex !important;
  visibility: visible !important;
}
/* Override específico do tema aurivita que tem seletor de ID mais forte */
#cc-pdp-complete-template--22056914714876__custom_product_qkafDR .cc-pdp__main-arrow,
#cc-pdp-complete-template--22056914714876__custom_product_qkafDR .cc-pdp__main-arrow.swiper-button-disabled,
#cc-pdp-complete-template--22056914714876__custom_product_qkafDR .cc-pdp__main-arrow.swiper-button-lock,
[id*="cc-pdp-complete"] .cc-pdp__main-arrow.swiper-button-disabled,
[id*="cc-pdp-complete"] .cc-pdp__main-arrow.swiper-button-lock{
  opacity: 1 !important;
  pointer-events: auto !important;
  cursor: pointer !important;
  display: flex !important;
}
</style>`);
    }

    if (true) {
      $('body').append(`<script data-landinglab-manual-carousel>(function(){
  // Inicializa carousel manual em cada .cc-pdp__main (galeria produto principal)
  function initGallery(){
    document.querySelectorAll('.cc-pdp__main').forEach(function(mainCarousel){
      if(mainCarousel.dataset.llManualInit) return;
      mainCarousel.dataset.llManualInit = '1';

      var mainSlides = mainCarousel.querySelectorAll('.cc-pdp__main-slide, .swiper-slide');
      if(mainSlides.length === 0) return;

      // Marca primeiro como ativo
      mainSlides.forEach(function(s, i){
        if(i === 0) s.classList.add('ll-active-main');
        else s.classList.remove('ll-active-main');
      });

      // Encontra thumbs correspondentes na mesma section
      var section = mainCarousel.closest('.cc-pdp__gallery-layout, .cc-pdp__container, .cc-pdp-complete') || mainCarousel.parentElement;
      var thumbsCarousel = section ? section.querySelector('.cc-pdp__thumbs') : null;
      var thumbs = thumbsCarousel ? thumbsCarousel.querySelectorAll('.cc-pdp__thumb, .swiper-slide') : [];

      thumbs.forEach(function(t, i){
        if(i === 0) t.classList.add('ll-active-thumb');
        t.style.cursor = 'pointer';
        t.addEventListener('click', function(e){
          e.preventDefault(); e.stopPropagation();
          setActive(i);
        });
      });

      // Setas prev/next
      var prevBtn = section ? section.querySelector('.cc-pdp__main-arrow--prev, [class*="main-arrow"][class*="prev"]') : null;
      var nextBtn = section ? section.querySelector('.cc-pdp__main-arrow--next, [class*="main-arrow"][class*="next"]') : null;
      var current = 0;

      function setActive(idx){
        if(idx < 0) idx = mainSlides.length - 1;
        if(idx >= mainSlides.length) idx = 0;
        current = idx;
        mainSlides.forEach(function(s, i){
          if(i === idx) s.classList.add('ll-active-main');
          else s.classList.remove('ll-active-main');
        });
        thumbs.forEach(function(t, i){
          if(i === idx) t.classList.add('ll-active-thumb');
          else t.classList.remove('ll-active-thumb');
        });
      }

      // BUG-CAROUSEL-ARROWS: remover classes swiper-button-disabled/lock que
      // ficam presas no HTML mesmo depois do Swiper falhar. Fica loopando via
      // MutationObserver — Swiper.js re-adiciona classes durante update()
      // e nosso CSS !important pega, mas por garantia removemos direto.
      function unlockButton(btn) {
        if (!btn) return;
        btn.classList.remove('swiper-button-disabled');
        btn.classList.remove('swiper-button-lock');
        btn.removeAttribute('disabled');
        btn.setAttribute('aria-disabled', 'false');
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
        btn.style.cursor = 'pointer';
        btn.style.display = 'flex';
      }
      if(prevBtn){
        unlockButton(prevBtn);
        prevBtn.addEventListener('click', function(e){
          e.preventDefault(); e.stopPropagation();
          setActive(current - 1);
        }, true);
        prevBtn.addEventListener('touchend', function(e){
          e.preventDefault(); e.stopPropagation();
          setActive(current - 1);
        }, true);
      }
      if(nextBtn){
        unlockButton(nextBtn);
        nextBtn.addEventListener('click', function(e){
          e.preventDefault(); e.stopPropagation();
          setActive(current + 1);
        }, true);
        nextBtn.addEventListener('touchend', function(e){
          e.preventDefault(); e.stopPropagation();
          setActive(current + 1);
        }, true);
      }
      // MutationObserver: Swiper pode re-adicionar as classes depois. Re-lock.
      var buttonWatcher = new MutationObserver(function(muts){
        muts.forEach(function(m){
          if (m.target === prevBtn || m.target === nextBtn) {
            unlockButton(m.target);
          }
        });
      });
      if (prevBtn) buttonWatcher.observe(prevBtn, { attributes: true, attributeFilter: ['class', 'disabled', 'style'] });
      if (nextBtn) buttonWatcher.observe(nextBtn, { attributes: true, attributeFilter: ['class', 'disabled', 'style'] });
    });
  }

  // initTabsWithPanels: fix tabs Passo 1-4 (doctors-see) + Settimana 1-10+ (timeline).
  // Padrao aurivita: cada tab tem aria-controls="panelId". Ao clicar, tab e panel
  // correspondente recebem .is-active. Adicionalmente, no timeline a imagem
  // principal esta em .cc-timeline__media (fora do panel), entao trocamos o src
  // dela pelo idx da tab clicada.
  function initTabsWithPanels(){
    document.querySelectorAll('[role="tab"][aria-controls]').forEach(function(tab){
      // Idempotência sem dataset — usa handler dedupe via reference no elemento.
      // Idempotência antiga (dataset.llTabInit) impedia re-init quando HTML tinha
      // dataset persistido no server-side render, deixando tabs sem handler.
      if(tab._llTabHandler) return;
      tab.style.cursor = 'pointer';
      var handler = function(e){
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        // Encontra container comum (section/div) que tem outras tabs
        var container = tab.closest('.cc-doctors-see, .cc-timeline, [class*="section"], section') || document.body;
        // Deactivate todas tabs sibling
        var allTabs = Array.from(container.querySelectorAll('[role="tab"][aria-controls]'));
        var tabIdx = allTabs.indexOf(tab);
        allTabs.forEach(function(t){
          t.classList.remove('is-active','active');
          t.setAttribute('aria-selected','false');
        });
        // Deactivate todos panels sibling.
        // ATENÇÃO: seletor [class*="__detail"] casa ATÉ com .cc-timeline__details
        // (o wrapper!) porém não faz mal remover is-active dele (não tem).
        container.querySelectorAll('[role="tabpanel"], [id*="-panel-"], [class*="__panel"], [class*="__detail"]').forEach(function(p){
          p.classList.remove('is-active','active');
        });
        // Activate tab clicado
        tab.classList.add('is-active');
        tab.setAttribute('aria-selected','true');
        // Activate panel controlado
        var panelId = tab.getAttribute('aria-controls');
        if(panelId){
          var panel = document.getElementById(panelId);
          if(panel){
            panel.classList.add('is-active');
          }
        }
        // TIMELINE + DOCTORS-SEE: usa tab.closest pra achar root da section.
        // Solucao definitiva: toggle position/opacity dos slides empilhados
        // (setup init destruiu Swiper).
        var sectionRoot = tab.closest('.cc-timeline, .cc-doctors-see');
        var swEl = sectionRoot ? sectionRoot.querySelector('.cc-timeline__swiper, .cc-doctors-see__swiper, .swiper') : null;
        if(swEl){
          var slides = swEl.querySelectorAll(':scope > .swiper-wrapper > .swiper-slide');
          slides.forEach(function(sl, i){
            if(i === tabIdx){
              sl.style.cssText = 'position:relative;inset:0;width:100%;height:auto;opacity:1;visibility:visible;';
            } else {
              sl.style.cssText = 'position:absolute;inset:0;width:100%;height:auto;opacity:0;visibility:hidden;';
            }
          });
        }
      };
      tab._llTabHandler = handler;
      tab.addEventListener('click', handler, true);
    });

    // TIMELINE + DOCTORS-SEE INIT: destroi Swiper, empilha slides absolute.
    // Generico pra ambas as sections (mesmo padrao swiper + tabs).
    ['.cc-timeline', '.cc-doctors-see'].forEach(function(sectionSel){
      document.querySelectorAll(sectionSel).forEach(function(sec){
        if(sec.dataset.llSectionInit) return;
        sec.dataset.llSectionInit = '1';
        var swEl = sec.querySelector('.cc-timeline__swiper, .cc-doctors-see__swiper, .swiper');
        if(!swEl) return;
        if(swEl.swiper && typeof swEl.swiper.destroy === 'function'){
          try { swEl.swiper.destroy(true, false); } catch(_){}
        }
        var wrap = swEl.querySelector(':scope > .swiper-wrapper');
        if(wrap){
          wrap.style.cssText = 'display:block;transform:none;position:relative;width:100%;height:auto;';
        }
        var tabs = Array.from(sec.querySelectorAll('[role="tab"][aria-controls]'));
        var initialIdx = 0;
        for(var i=0; i<tabs.length; i++){
          if(tabs[i].getAttribute('aria-selected') === 'true' || tabs[i].classList.contains('is-active')){
            initialIdx = i; break;
          }
        }
        swEl.querySelectorAll(':scope > .swiper-wrapper > .swiper-slide').forEach(function(sl, i){
          if(i === initialIdx){
            sl.style.cssText = 'position:relative;inset:0;width:100%;height:auto;opacity:1;visibility:visible;';
          } else {
            sl.style.cssText = 'position:absolute;inset:0;width:100%;height:auto;opacity:0;visibility:hidden;';
          }
        });
        swEl.style.setProperty('overflow', 'visible', 'important');
      });
    });
  }

  function tick(){
    initGallery();
    initTabsWithPanels();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();
  var attempts = 0;
  var timer = setInterval(function(){ tick(); attempts++; if(attempts > 15) clearInterval(timer); }, 400);
})();</script>`);
    }
    logger.info({ jobId: job.id }, 'apply-bundle: injected manual carousel + tabs (no Swiper)');

    // 5. Auto-bind: anota data-landing-variant-id nos N primeiros cards de bundle.
    //
    // Fase 9B (recovery — 26/09/2026): integração no processor que ficou fora
    // do merge do PR #114. Chama renderBundleOffers extraída em
    // apps/worker/src/lib/render-bundle-offers.ts.
    //
    // COMPORTAMENTO IDÊNTICO ao inline pré-9B — mesmos seletores, mesma ordem
    // de mutação. Log de counts preservado.
    //
    // Log "9B renderer path" é RUNTIME EVIDENCE: prova que caminho extraído foi
    // executado. Se aparecer em Railway logs, refactor está ativo. Se ausente
    // (log antigo "bundle cards bound + prices rewritten" sozinho), integração
    // regrediu de novo.
    const cards = detectBundleCards($);

    // Fase 10.4 — Adapter shadow mode.
    // Executa Kaching Bundles Component Adapter em paralelo APENAS PARA
    // TELEMETRIA. Pipeline legado (detectBundleCards → renderBundleOffers)
    // continua 100% autoritativo. Zero mutação HTML garantida por design
    // do adapter (usa cheerio.load(html) local).
    //
    // Feature flag: LANDINGLAB_ADAPTER_SHADOW=true (default OFF).
    // Ver: docs/architecture/adr-001-theme-adapter-contract.md §8
    if (isShadowEnabled()) {
      try {
        const shadowRecord = await runAdapterShadow({
          html: page.htmlBody,
          $,
          landingPageId,
          landingKind: page.landingKind,
          bundleAdapterHint: page.bundleAdapter,
          legacyCards: cards as never,
        });
        logger.info(
          {
            jobId: job.id,
            // landingPageId vem do spread (shadowRecord.landingPageId === landingPageId).
            ...shadowRecord,
          },
          'adapter-shadow: evidence recorded',
        );
      } catch (err) {
        // Shadow NUNCA pode quebrar apply-bundle. Log e continua.
        logger.warn(
          {
            jobId: job.id,
            landingPageId,
            adapterShadowError: err instanceof Error ? err.message : String(err),
          },
          'adapter-shadow: unexpected error swallowed',
        );
      }
    }

    // Fase 11.4 — Semantic mapper shadow.
    // Compõe family classifier + adapters + shared detectors → PageSemanticModel.
    // Observação only. Zero HTML mutation. Zero autoridade.
    // Feature flag: LANDINGLAB_SEMANTIC_SHADOW=true (default OFF).
    if (isSemanticShadowEnabled()) {
      try {
        const semanticRecord = await runSemanticShadow({
          html: page.htmlBody,
          $,
          landingPageId,
          landingKind: page.landingKind,
        });
        logger.info(
          {
            jobId: job.id,
            // landingPageId vem do spread (semanticRecord.landingPageId === landingPageId).
            ...semanticRecord,
          },
          'semantic-shadow: evidence recorded',
        );
      } catch (err) {
        logger.warn(
          {
            jobId: job.id,
            landingPageId,
            semanticShadowError: err instanceof Error ? err.message : String(err),
          },
          'semantic-shadow: unexpected error swallowed',
        );
      }
    }

    // Fase 10.5 — Bundle target strangler cut.
    // Substitui APENAS a origem dos cards passados pra renderBundleOffers.
    // Legacy detectBundleCards continua chamado acima (parity guard + fallback).
    // renderBundleOffers permanece INALTERADO.
    //
    // Feature flag: LANDINGLAB_ADAPTER_KACHING_ENABLED=true (default OFF).
    // Com flag OFF → bundleCards === legacy cards (comportamento pré-10.5 exato).
    // Com flag ON → adapter fornece cards SE E SOMENTE SE:
    //   - resolver = confident + chosen = kaching
    //   - bundle region critical válida com confidence >= 0.60
    //   - parity guard: count + order === legacy
    // Qualquer falha → fallback silencioso pra legacy + log estruturado.
    //
    // Ver: docs/architecture/adr-001-theme-adapter-contract.md §9 (Migration path)
    let bundleCards: typeof cards = cards;
    try {
      const authorityDecision = await resolveBundleAuthority({
        html: page.htmlBody,
        $,
        landingPageId,
        landingKind: page.landingKind,
        bundleAdapterHint: page.bundleAdapter,
        legacyCards: cards as never,
      });
      logger.info(
        {
          jobId: job.id,
          landingPageId,
          ...authorityDecision,
          // Non-serializable field — omitir do log
          cards: undefined,
        },
        `bundle-target-authority: ${authorityDecision.authority}`,
      );
      if (authorityDecision.authority === 'adapter') {
        bundleCards = authorityDecision.cards as typeof cards;
      }
    } catch (err) {
      // Authority resolver NUNCA pode quebrar apply-bundle.
      // Log + mantém bundleCards = legacy cards.
      logger.warn(
        {
          jobId: job.id,
          landingPageId,
          bundleTargetAuthority: 'legacy',
          authorityError: err instanceof Error ? err.message : String(err),
          fallbackReason: 'authority_resolver_unexpected_error',
        },
        'bundle-target-authority: unexpected error swallowed, using legacy',
      );
    }

    const { variantsBound, pricesRewritten } = renderBundleOffers($, {
      cards: bundleCards as never,
      variants,
      currency: page.currency ?? 'EUR',
      landingPageId,
      fmtPrice,
    });
    if (bundleCards.length > 0 && variants.length > 0) {
      logger.info(
        {
          jobId: job.id,
          cardsDetected: bundleCards.length,
          legacyCardsDetected: cards.length, // Fase 10.5: evidência dual
          variantsAvailable: variants.length,
          variantsBound,
          pricesRewritten,
          renderer: 'renderBundleOffers', // Runtime evidence (Fase 9B recovery)
        },
        'apply-bundle: bundle cards bound + prices rewritten',
      );
    } else {
      logger.warn(
        {
          jobId: job.id,
          cardsDetected: bundleCards.length,
          legacyCardsDetected: cards.length,
          variantsAvailable: variants.length,
          renderer: 'renderBundleOffers', // Runtime evidence
        },
        'apply-bundle: no bundle cards detected or no variants — skip auto-bind',
      );
    }

    // 5.0b. Título/badge visíveis das ofertas = landing_bundle_offers (o preço
    //       já é reescrito acima). Só com a fonte nova (bundle_offers): a
    //       legada não tem badge. Mesmos cards e ordem do renderBundleOffers.
    if (variantsSource === 'bundle_offers' && bundleCards.length > 0) {
      const labels = renderBundleLabels($, {
        cards: bundleCards as never,
        offers: bundleOffersRows.map((o) => ({ title: o.title, badge: o.badge })),
      });
      logger.info({ jobId: job.id, ...labels, renderer: 'renderBundleLabels' }, 'apply-bundle: offer titles/badges synced');
    }

    // 5.05. Reescreve <script data-cc-pdp-product-json> (tema Aurivita lê pra
    //       popular preços dinâmicos do CTA "Aggiungi al carrello × qty").
    //
    // Fase 9C (26/09/2026): extração cirúrgica pra apps/worker/src/lib/render-product-json.ts.
    // COMPORTAMENTO IDÊNTICO ao inline pré-9C — mesmos seletores, mesmo parse,
    // mesma política de erro (JSON inválido → silent skip).
    //
    // Log inclui { renderer: 'renderProductJson' } como RUNTIME EVIDENCE
    // (mesmo padrão da 9B recovery — prova que caminho novo foi executado).
    const primaryVariant = variants[0];
    const { productJsonRewritten } = primaryVariant
      ? renderProductJson($, {
          primaryVariant,
          currency: page.currency ?? 'EUR',
          currencySymbol,
          fmtPrice,
        })
      : { productJsonRewritten: 0 };
    if (productJsonRewritten > 0) {
      logger.info(
        {
          jobId: job.id,
          productJsonRewritten,
          renderer: 'renderProductJson', // Runtime evidence (Fase 9C)
        },
        'apply-bundle: rewrote product JSON (currency + prices)',
      );
    }

    // 5.1. Reescreve preços do CTA principal (Aggiungi al carrello) usando o
    //      bundle "recomendado" — se algum card tem is-selected, usa ele; senão
    //      usa o primeiro. Client-side JS depois atualiza quando muda bundle.
    let ctaPricesRewritten = 0;
    const preSelectedIdx = bundleCards.toArray().findIndex(el =>
      ($(el).attr('class') || '').includes('is-selected'),
    );
    const defaultVariantIdx = preSelectedIdx >= 0 && preSelectedIdx < variants.length
      ? preSelectedIdx
      : 0;
    const defaultVariant = variants[defaultVariantIdx];
    if (defaultVariant) {
      const priceStr = fmtPrice(defaultVariant.price);
      const compareStr = fmtPrice(defaultVariant.compareAtPrice);
      // Selectors dos price spans do CTA (main-atc, product-form__submit, etc)
      const ctaPriceSelectors = [
        '[data-cc-atc-append]',
        '.main-atc__price',
        '.product-form__price',
        '[class*="atc"] [class*="price"]',
      ];
      for (const sel of ctaPriceSelectors) {
        const container = $(sel).first();
        if (container.length === 0) continue;
        // Substitui $XX / $XXX.XX por priceStr/compareStr respeitando ordem
        // (primeiro span = preço, span com line-through = compare)
        const spans = container.find('span');
        let priceApplied = false;
        let compareApplied = false;
        spans.each((_, span) => {
          const $span = $(span);
          const style = ($span.attr('style') || '').toLowerCase();
          if (!priceApplied && !style.includes('line-through') && /\$|€|£|R\$/.test($span.text())) {
            $span.text(priceStr);
            priceApplied = true;
            ctaPricesRewritten++;
          } else if (!compareApplied && style.includes('line-through')) {
            $span.text(compareStr);
            compareApplied = true;
            ctaPricesRewritten++;
          }
        });
        if (priceApplied || compareApplied) break;
      }
    }
    if (ctaPricesRewritten > 0) {
      logger.info({ jobId: job.id, ctaPricesRewritten }, 'apply-bundle: CTA prices rewritten');
    }

    // 5.9. Locale do widget/CTA (E2E Stripe B-3/B-4): landing Stripe usa o
    //      idioma do mercado (o mesmo do checkout e dos e-mails).
    let marketLocale: string | null = null;
    if (page.checkoutProvider === 'stripe' && page.marketId) {
      try {
        const [market] = await db
          .select({ locale: landingMarkets.locale })
          .from(landingMarkets)
          .where(eq(landingMarkets.id, page.marketId))
          .limit(1);
        marketLocale = market?.locale ?? null;
      } catch (err) {
        logger.warn({ jobId: job.id, err: (err as Error).message }, 'apply-bundle: falha ao ler locale do mercado — usa idioma da landing');
      }
    }
    const widgetLocale = resolveWidgetLocale({
      checkoutProvider: page.checkoutProvider,
      marketLocale,
      targetLanguage: page.targetLanguage,
      htmlLang: $('html').attr('lang') ?? null,
    });
    const ctaLabels = ctaLabelsFor(widgetLocale, page.checkoutProvider);

    // 6. Anota data-landing-cta="buy" no botão principal + muda submit → button
    //    (evita form submit nativo /cart/add do Shopify).
    const cta = detectBuyCta($);
    let ctaAnnotated = false;
    // Idempotente: rótulos de uma execução anterior saem antes de reaplicar.
    $('[data-landing-cta-labels]').removeAttr('data-landing-cta-labels');
    if (cta.length > 0) {
      cta.attr('data-landing-cta', 'buy');
      cta.attr('data-landing-qty', '1');
      if (cta.attr('type') === 'submit') cta.attr('type', 'button');
      ctaAnnotated = true;
      // Stripe + mercado não-inglês: "Add to cart - €19.00" do tema clonado →
      // "Aggiungi al carrello - €19.00". Só a frase em inglês muda; a Engine V2
      // do storefront lê data-landing-cta-labels e reaplica a cada troca de oferta.
      if (ctaLabels) {
        cta.attr('data-landing-cta-labels', JSON.stringify(ctaLabels));
        const roots = cta.add($('.shop-add-to-cart-button .button-text, .kaching-bundles__cta .button-text'));
        roots.find('*').addBack().contents().each((_, node) => {
          if (node.type !== 'text') return;
          const next = relabelCtaText(node.data, ctaLabels);
          if (next !== node.data) node.data = next;
        });
      }
      logger.info({ jobId: job.id, ctaTag: cta.prop('tagName') }, 'apply-bundle: CTA annotated');
    } else {
      logger.warn({ jobId: job.id }, 'apply-bundle: no CTA button detected — checkout only works via card click');
    }

    // 7. Asset-resurrector DESATIVADO (removido) — estava criando 4 <script>
    //    backup por asset failed, cada um apontando pra aurivita.co (que
    //    retorna CORS block) → quadruplicava os erros de console em vez de
    //    resolver. Se um asset Supabase falha, deixa falhar silenciosamente.

    // 7.1. Server-side asset fallback REMOVIDO: quando substituía a URL Supabase
    //      por aurivita.co CDN, o navegador cliente batia em CORS block
    //      (aurivita.co não seta Access-Control-Allow-Origin para nosso
    //      storefront). Melhor deixar Supabase 404 do que gerar 4 CORS por asset.
    const assetsFixed = 0;
    const assetsChecked = 0;

    // 7.15. Swiper CDN + reinit REMOVIDOS — substituídos por grid estática
    //       em 4.99 (mais simples e sempre funciona).

    // 7.15. Meta Pixel (Facebook) — busca landing_pixels ativo; se null,
    //       fallback pra tracking_pixels store_id='default' (multi-tenant default).
    //       Idempotente: remove qualquer <script data-landinglab-pixel> anterior.
    let pixelInjected = false;
    let pixelIdUsed: string | null = null;
    let pixelSource: 'landing_pixels' | GlobalPixelSource | null = null;
    try {
      const [landingPixel] = await db
        .select({
          pixelId: landingPixels.pixelId,
          eventTestCode: landingPixels.eventTestCode,
          provider: landingPixels.provider,
        })
        .from(landingPixels)
        .where(
          and(
            eq(landingPixels.landingPageId, landingPageId),
            eq(landingPixels.isActive, true),
          ),
        )
        .limit(1);

      let resolved: { pixelId: string; eventTestCode: string | null } | null = null;
      if (landingPixel && landingPixel.provider === 'meta' && isValidPixelId(landingPixel.pixelId)) {
        resolved = { pixelId: landingPixel.pixelId, eventTestCode: landingPixel.eventTestCode };
        pixelSource = 'landing_pixels';
      } else {
        // Story 23.1b · pixel global da loja da landing (lib/landing-global-pixel.ts).
        const globalPx = await resolveLandingGlobalPixel(db, landingPageId, { ordered: false });
        if (globalPx && isValidPixelId(globalPx.pixelId)) {
          resolved = { pixelId: globalPx.pixelId, eventTestCode: null };
          pixelSource = globalPx.source;
          // Sem cópia em landing_pixels: a landing segue o pixel de
          // Configurações → Tracking (o storefront aplica o atual a cada request).
        }
      }

      if (resolved) {
        // Remove pixels antigos (Fase 9 pre-9B fix, 26/09/2026):
        //
        // ANTES: só removia <script data-landinglab-pixel> e <noscript> de
        // facebook.com/tr. Comentários HTML "Meta Pixel (LandingLab
        // auto-injected)" e "End Meta Pixel" adjacentes ficavam órfãos.
        // Cada re-run acumulava +72 bytes de lixo (comentários duplicados).
        //
        // AGORA: remove também os comentários LandingLab. Restrições:
        // - MARKER específico "LandingLab auto-injected" — não toca comentários
        //   legítimos do tema/site origem que digam "Meta Pixel" genérico.
        // - "End Meta Pixel" só é removido se estiver IMEDIATAMENTE após
        //   (nextSibling em texto/whitespace) um marker LandingLab. Preserva
        //   Meta Pixels legítimos de terceiros.
        $('script[data-landinglab-pixel]').remove();
        $('noscript').each((_, el) => {
          const html = $(el).html() || '';
          if (/facebook\.com\/tr\?id=/.test(html)) $(el).remove();
        });
        removeLandingLabPixelComments($);
        const snippet = buildMetaPixelSnippet(
          resolved.pixelId,
          resolved.eventTestCode ?? null,
          landingPageId === '3f6cb682-977c-4c09-9ab0-d1bc6dae2583' ? 2500 : 0,
        );
        // Injeta no <head> pra fbq() disponível quando handlers rodarem.
        if ($('head').length > 0) $('head').append(snippet);
        else $('body').prepend(snippet);
        pixelInjected = true;
        pixelIdUsed = resolved.pixelId;
      }
    } catch (err) {
      logger.warn({ jobId: job.id, err: (err as Error).message }, 'apply-bundle: pixel injection failed');
    }
    if (pixelInjected) {
      logger.info(
        { jobId: job.id, pixelIdUsed, pixelSource },
        'apply-bundle: Meta Pixel injected',
      );
    } else {
      logger.warn({ jobId: job.id }, 'apply-bundle: no active pixel found — skipped injection');
    }

    // 7.2. Injeta script checkout-handler + faq-handler no fim do <body>.
    //      Os dois scripts são separados pra que o sanitizer do storefront possa
    //      preservar o faq-handler independentemente do checkout-handler (Engine V2
    //      mata o checkout-handler; o faq-handler deve sobreviver).
    const handlerScript = buildCheckoutHandlerScript(CHECKOUT_API_URL);
    $('body').append(handlerScript);
    $('script[data-landinglab-faq-handler]').remove();
    $('body').append(buildFaqHandlerScript());
    const handlerInjected = true;

    // 7.3. Bundle-select fallback — funciona MESMO sem data-landing-variant-id.
    //      Necessário para landings clonadas ANTES do wizard, pra selecionar
    //      cards no preview. Ver playbook seção 10.
    $('script[data-landinglab-bundle-select]').remove();
    $('body').append(`<script data-landinglab-bundle-select>(function(){
  function initBundleSelect(){
    var cards = document.querySelectorAll('button.cc-pdp-offer, .kaching-bundles__bar[data-deal-bar-id]');
    if(cards.length === 0) return;
    var hasActive = document.querySelector('[data-landing-variant-active="true"]');
    if(!hasActive){
      var preSel = document.querySelector('button.cc-pdp-offer.is-selected, .kaching-bundles__bar.is-selected, .kaching-bundles__bar--selected');
      if(preSel && preSel.getAttribute('data-landing-variant-id')){
        preSel.setAttribute('data-landing-variant-active', 'true');
      }
    }
    cards.forEach(function(card){
      if(card.dataset.llBundleSelectInit) return;
      card.dataset.llBundleSelectInit = '1';
      card.style.cursor = 'pointer';
      card.addEventListener('click', function(e){
        if(card.getAttribute('data-landing-cta') === 'buy') return;
        cards.forEach(function(other){
          if(other === card) return;
          other.classList.remove('is-selected','is-highlighted','is-active','active','kaching-bundles__bar--selected');
          other.setAttribute('aria-selected','false');
          other.removeAttribute('data-landing-variant-active');
        });
        card.classList.add('is-selected','is-highlighted','kaching-bundles__bar--selected');
        card.setAttribute('aria-selected','true');
        var vid = card.getAttribute('data-landing-variant-id');
        if(vid){ card.setAttribute('data-landing-variant-active', 'true'); }
        // Kaching: sincroniza radio nativo e re-dispara deal-bar-selected
        // para o applyPrices do tema atualizar o CTA text ("Add to cart - $XX").
        var radio = card.querySelector('input[type="radio"]');
        if(radio){ radio.checked = true; }
        document.dispatchEvent(new CustomEvent('deal-bar-selected', { bubbles: true, detail: { barId: card.getAttribute('data-deal-bar-id') } }));
      }, true);
    });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBundleSelect);
  else initBundleSelect();
  var attempts = 0;
  var timer = setInterval(function(){ initBundleSelect(); attempts++; if(attempts > 10) clearInterval(timer); }, 500);
})();</script>`);
    $('style[data-landinglab-bundle-select]').remove();
    $('head').append(`<style data-landinglab-bundle-select>
button.cc-pdp-offer,
.kaching-bundles__bar,
[class*="__bundle"],
[class*="bundle-selector"] > *{
  pointer-events:auto!important;
  cursor:pointer!important;
}
</style>`);

    // 7.4. Subscription Presentation Mode — widget Subscribe & Save.
    //      Shopify: Blackshop é somente camada visual: não cria nem edita selling plans.
    //      A única ligação com Shopify é passar sellingPlanId no cartCreate.
    //      Proteção operacional: se subsEnabled=true mas subsSellingPlanId=null,
    //      o widget NÃO é injetado (evita "assinatura falsa" no checkout).
    //      Stripe (Story 15.6): injetado com subsEnabled + subsInterval (sem
    //      selling plan; data-plan-id omitido, data-provider="stripe"); o CTA
    //      manda `subscribe: true` e o servidor cobra a assinatura real.
    //      Decisão em lib/landing-subs-widget.ts (subsWidgetMode).
    //      Idempotente: remove tudo antes de reinjetar (apply-bundle 2x = mesmo resultado).
    $('div[data-landinglab-subs-widget]').remove();
    $('style[data-landinglab-subs-widget]').remove();
    $('script[data-landinglab-subs-widget-init]').remove();
    const subsMode = subsWidgetMode(page);
    if (subsMode) {
      const stripeSubs = subsMode.mode === 'stripe';
      const planId = subsMode.mode === 'shopify' ? subsMode.planId : '';
      // discountPercent é autoritativo; fallback (só Shopify): parse do discountLabel legado.
      let pctNum = stripeSubs
        ? subsMode.discountPercent
        : typeof page.subsDiscountPercent === 'number' ? page.subsDiscountPercent : 0;
      if (pctNum <= 0 && !stripeSubs) {
        const labelMatch = (page.subsDiscountLabel ?? '').match(/(\d{1,2})\s*%/);
        pctNum = labelMatch ? parseInt(labelMatch[1]!, 10) : 0;
      }
      const label = stripeSubs ? '' : (page.subsDiscountLabel ?? '').trim();
      const preselected = page.subsPreselected === true;
      // Locale: Stripe → mercado da landing; Shopify → targetLanguage → <html lang>.
      // Fallback 'en' — nunca 'it' (causa textos italianos em landings não-italianas).
      const locale = widgetLocale;
      const T: Record<string, { main: string; sub: string; hint: string; unavailable: string }> = {
        it: { main: 'Abbonati e risparmia', sub: 'Disdici in qualsiasi momento', hint: 'Prezzo abbonamento', unavailable: 'Abbonamento non disponibile. Seleziona acquisto singolo.' },
        pt: { main: 'Assinar e economizar', sub: 'Cancele a qualquer momento', hint: 'Preço com assinatura', unavailable: 'Assinatura indisponível. Selecione compra única.' },
        es: { main: 'Suscríbete y ahorra', sub: 'Cancela cuando quieras', hint: 'Precio con suscripción', unavailable: 'Suscripción no disponible. Selecciona compra única.' },
        fr: { main: "S'abonner et économiser", sub: 'Résiliez à tout moment', hint: 'Prix abonnement', unavailable: 'Abonnement indisponible. Sélectionnez achat unique.' },
        de: { main: 'Abonnieren und sparen', sub: 'Jederzeit kündbar', hint: 'Abo-Preis', unavailable: 'Abo nicht verfügbar. Einmalkauf wählen.' },
        en: { main: 'Subscribe & Save', sub: 'Cancel anytime, no restrictions', hint: 'Subscription price', unavailable: 'Subscription is currently unavailable. Please select one-time purchase.' },
        ja: { main: 'サブスクで節約', sub: 'いつでもキャンセル可能', hint: 'サブスク価格', unavailable: 'サブスクは現在ご利用いただけません。通常購入をお選びください。' },
        zh: { main: '订阅并节省', sub: '随时取消', hint: '订阅价格', unavailable: '订阅目前不可用，请选择一次性购买。' },
        ko: { main: '구독하고 절약하기', sub: '언제든지 취소 가능', hint: '구독 가격', unavailable: '구독을 현재 이용할 수 없습니다. 일반 구매를 선택해 주세요.' },
      };
      const t = T[locale] ?? T.en!;
      const firstCard = bundleCards.first();
      if (firstCard.length > 0) {
        const kachingWrapper = firstCard.closest('kaching-bundles-block, .kaching-bundles__block, .kaching-bundles');
        const anchor = kachingWrapper.length > 0 ? kachingWrapper : firstCard.parent();
        const checkedAttr = preselected ? ' checked' : '';
        const activeAttr = preselected ? 'true' : 'false';
        // input.value: quando pré-selecionado nasce com planId; desmarcado nasce vazio.
        const inputValue = preselected ? planId : '';
        const badgeHtml = (pctNum > 0)
          ? ` <b class="ll-subs__badge">${escapeHtml(subsBadgeText(locale, pctNum))}</b>`
          : (label ? ` <b class="ll-subs__badge">${escapeHtml(label)}</b>` : '');
        const subsDigits = currencyMinorUnitDigits(pageCurrencyCode);
        // Stripe: sem selling plan — data-plan-id omitido e data-provider="stripe".
        const planAttr = stripeSubs ? 'data-provider="stripe"' : `data-plan-id="${planId}"`;
        const widgetHtml = `<div data-landinglab-subs-widget class="ll-subs" ${planAttr} data-pct="${pctNum}" data-digits="${subsDigits}" data-sym="${escapeHtml(currencySymbol)}" data-active="${activeAttr}" data-unavailable-msg="${escapeHtml(t.unavailable)}">
  <label class="ll-subs__row">
    <input type="checkbox" class="ll-subs__check" data-landinglab-subs-check${checkedAttr}>
    <span class="ll-subs__texts">
      <span class="ll-subs__main">${escapeHtml(t.main)}${badgeHtml}</span>
      <span class="ll-subs__sub">${escapeHtml(t.sub)}</span>
    </span>
  </label>
  <div class="ll-subs__prices" data-landinglab-subs-prices hidden></div>
  <input type="hidden" name="selling_plan" value="${inputValue}" data-landinglab-subs-input>
</div>`;
        anchor.after(widgetHtml);
        // CSS scoped: herda font/color da landing, mas usa variáveis próprias
        // para bordas e backgrounds. Não polui global.
        $('head').append(`<style data-landinglab-subs-widget>
.ll-subs{margin:12px 0;padding:12px 14px;border:1.5px solid;border-color:inherit;border-radius:inherit;font-family:inherit;color:inherit;box-sizing:border-box}
.ll-subs[data-active="true"]{background:rgba(0,74,47,.06);border-color:rgba(0,74,47,.35)}
.ll-subs__row{display:flex;align-items:flex-start;gap:10px;cursor:pointer;user-select:none;margin:0}
.ll-subs__check{width:18px;height:18px;flex-shrink:0;margin-top:2px;cursor:pointer;accent-color:currentColor}
.ll-subs__texts{display:flex;flex-direction:column;gap:2px}
.ll-subs__main{font-size:14px;font-weight:700;line-height:1.3}
.ll-subs__sub{font-size:12px;opacity:.7;line-height:1.3}
.ll-subs__badge{display:inline-block;margin-left:6px;padding:1px 7px;background:#065f46;color:#fff;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.02em;vertical-align:middle}
.ll-subs__prices{margin:8px 0 0 28px;font-size:12px;display:flex;flex-wrap:wrap;gap:6px 12px}
.ll-subs__price-item{display:flex;gap:4px;align-items:baseline}
.ll-subs__price-label{opacity:.7}
.ll-subs__price-val{font-weight:700}
</style>`);
        // Runtime: preço visual = BASE × (1 - pct/100).
        // NUNCA acumular desconto: sempre recalcula do base price original.
        // Quando desmarcar: restaura exatamente o texto original (salvo em data-base-text).
        // Sem sellingPlanId válido (input.value vazio após check): mostra msg de erro,
        // NÃO deixa checkout prosseguir como one-time silenciosamente.
        $('body').append(`<script data-landinglab-subs-widget-init>(function(){
  var widget = document.querySelector('div[data-landinglab-subs-widget]');
  if(!widget||widget.__llSubsBound) return;
  widget.__llSubsBound = true;
  var check = widget.querySelector('[data-landinglab-subs-check]');
  var input = widget.querySelector('[data-landinglab-subs-input]');
  var pricesEl = widget.querySelector('[data-landinglab-subs-prices]');
  var planId = widget.getAttribute('data-plan-id') || '';
  var pct = parseFloat(widget.getAttribute('data-pct') || '0') || 0;
  var digits = parseInt(widget.getAttribute('data-digits') || '2', 10);
  var sym = widget.getAttribute('data-sym') || '';
  var unavailableMsg = widget.getAttribute('data-unavailable-msg') || 'Subscription unavailable.';
  // Coleta TODOS os cards de bundle e salva base price text (imutável).
  var cards = Array.from(document.querySelectorAll('[data-landing-variant-id]:not([data-landing-cta])'));
  var basePrices = new Map();
  function collectBase(){
    cards.forEach(function(card){
      var id = card.getAttribute('data-landing-variant-id');
      if(basePrices.has(id)) return;
      var el = card.querySelector('.kaching-bundles__bar-price,.cc-pdp-offer__price,[class*="__price"]:not([class*="compare"]):not([class*="full-price"])');
      if(el) basePrices.set(id, el.textContent.trim());
    });
  }
  collectBase();
  function parsePriceStr(str){
    if(!str) return null;
    // Strip currency symbols (including ¥ ￥ € $ £ and multi-char like C$ A$ CHF kr)
    var raw = String(str).replace(/[¥￥€$£₩₽R]|[A-Z]{1,3}\\$?|kr\\.?/g,'').trim();
    // For zero-decimal currencies (digits=0): commas are thousand separators — strip all
    // For decimal currencies: last comma/dot is decimal separator
    var num;
    if(digits===0){
      num = parseFloat(raw.replace(/[,. ]/g,''));
    } else {
      // Detect decimal separator: if last separator is comma, it's decimal (European)
      var lastComma = raw.lastIndexOf(',');
      var lastDot = raw.lastIndexOf('.');
      if(lastComma > lastDot){
        // comma is decimal: remove dots (thousand sep), replace comma with dot
        num = parseFloat(raw.replace(/\\./g,'').replace(',','.'));
      } else {
        // dot is decimal: remove commas (thousand sep)
        num = parseFloat(raw.replace(/,/g,''));
      }
    }
    if(isNaN(num)) return null;
    return {num:num};
  }
  function fmtPrice(n){
    var rounded = digits===0 ? Math.round(n) : parseFloat(n.toFixed(digits));
    var str = digits===0
      ? rounded.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,',')
      : rounded.toFixed(digits).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');
    return sym+str;
  }
  function applyPrices(active){
    if(pct<=0){ if(pricesEl) pricesEl.hidden=true; return; }
    // Atualiza display de preços de cada bundle
    cards.forEach(function(card){
      var id = card.getAttribute('data-landing-variant-id');
      var base = basePrices.get(id);
      var priceEl = card.querySelector('.kaching-bundles__bar-price,.cc-pdp-offer__price,[class*="__price"]:not([class*="compare"]):not([class*="full-price"])');
      if(!priceEl) return;
      if(active && pct>0){
        var p = parsePriceStr(base || priceEl.textContent.trim());
        if(p) priceEl.textContent = fmtPrice(p.num*(1-pct/100));
      } else {
        if(base) priceEl.textContent = base;
      }
    });
    // Atualiza painel de preços
    if(pricesEl){
      if(active && pct>0){
        var activeCard = document.querySelector('[data-landing-variant-active="true"]');
        var id2 = activeCard && activeCard.getAttribute('data-landing-variant-id');
        var base2 = id2 && basePrices.get(id2);
        var p2 = parsePriceStr(base2||'');
        if(p2){
          pricesEl.innerHTML='<span class="ll-subs__price-item">'
            +'<span class="ll-subs__price-val">'+fmtPrice(p2.num*(1-pct/100))+'</span>'
            +'</span>';
          pricesEl.hidden=false;
        }
      } else {
        pricesEl.hidden=true;
      }
    }
  }
  function sync(){
    var checked = check.checked;
    input.value = checked ? planId : '';
    widget.setAttribute('data-active', checked ? 'true' : 'false');
    applyPrices(checked);
    // Verifica se planId está presente quando selecionado
    if(${stripeSubs ? 'false' : 'checked && !planId'}){
      check.checked = false;
      input.value = '';
      widget.setAttribute('data-active','false');
      applyPrices(false);
      alert(unavailableMsg);
      return;
    }
  }
  check.addEventListener('change', sync);
  // MutationObserver para reação a mudança de bundle ativo
  var obs = new MutationObserver(function(muts){
    for(var i=0;i<muts.length;i++){
      if(muts[i].attributeName==='data-landing-variant-active'){
        collectBase();
        if(check.checked) applyPrices(true);
        break;
      }
    }
  });
  cards.forEach(function(el){ obs.observe(el,{attributes:true,attributeFilter:['data-landing-variant-active']}); });
  // Intercepta checkout: se subscription ON mas planId ausente → bloqueia
  document.addEventListener('click', function(e){
    var cta = e.target && e.target.closest && e.target.closest('[data-landing-cta="buy"]');
    if(!cta) return;
    if(${stripeSubs ? 'false' : 'check.checked && !input.value'}){
      e.stopImmediatePropagation();
      e.preventDefault();
      alert(unavailableMsg);
    }
  }, true);
  // Init com retry: Kaching pode renderizar preços depois do script.
  // Se basePrices.size===0 após collectBase(), aguarda até 20 frames (~333ms).
  var _initRetries = 0;
  function _tryInit(){
    collectBase();
    if(basePrices.size > 0 || _initRetries >= 20){
      sync();
    } else {
      _initRetries++;
      requestAnimationFrame(_tryInit);
    }
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', _tryInit);
  } else {
    _tryInit();
  }
})();</script>`);
        logger.info(
          { jobId: job.id, planId, pctNum, preselected, locale, provider: subsMode.mode },
          'apply-bundle: subs widget injected (presentation mode)',
        );
      } else {
        logger.warn({ jobId: job.id }, 'apply-bundle: subs enabled but no bundle card found — widget skipped');
      }
    }

    // 7.5. Accordion universal — cobre 4 padrões que aparecem em clones:
    //   - .pss-accordion-trigger + .pss-accordion-panel (PSS Product Studio — Klensia)
    //   - .faq-img-question + .faq-img-answer (FAQ com imagem — Klensia)
    //   - .cc-faq__question + .cc-faq__answer (Aurivita/Bepurex)
    //
    // INVARIANTE DE LOCALIDADE (2026-09-29):
    //   .faq-img-item/.faq-img-answer NÃO recebem CSS max-height:0 aqui.
    //   Motivo: o tema Klensia (inline script initFaqImgSection) gerencia o
    //   FAQ via style.maxHeight inline. O CSS do tema define max-height:500px
    //   como estado inicial (aberto). Qualquer override CSS nosso que feche
    //   os painéis conflita com o handler nativo e quebra o accordion.
    //   wireKlensiaFaq() wira SEMPRE via llAccWired por botão (idempotente).
    //   Guard data-faq-img-init removido (fix 2026-09-30): sanitizer substitui nós.
    $('style[data-landinglab-accordion-fix]').remove();
    $('script[data-landinglab-accordion-fix]').remove();
    const accordionMarkers = $(
      '.pss-accordion-trigger, .faq-img-question, .cc-faq__question',
    );
    if (accordionMarkers.length > 0) {
      $('head').append(`<style data-landinglab-accordion-fix>
.pss-accordion-panel,.cc-faq__answer{display:none !important;}
.pss-accordion-trigger[aria-expanded="true"] + .pss-accordion-panel,
.pss-accordion-trigger[aria-expanded="true"] ~ .pss-accordion-panel,
.pss-accordion-panel.is-open{display:block !important;}
.cc-faq__question[aria-expanded="true"] + .cc-faq__answer,
.cc-faq__question[aria-expanded="true"] ~ .cc-faq__answer,
.cc-faq__answer.is-open{display:block !important;}
</style>`);
      $('body').append(`<script data-landinglab-accordion-fix>(function(){
function findPanel(t, panelSel){
  var dataTarget = t.getAttribute('data-target') || t.getAttribute('data-id');
  if(dataTarget){
    var id = dataTarget.replace(/^#/, '');
    var el = document.getElementById(id) || document.querySelector('[data-panel-id="'+id+'"]');
    if(el) return el;
  }
  var ac = t.getAttribute('aria-controls');
  if(ac){ var el2 = document.getElementById(ac); if(el2) return el2; }
  if(t.nextElementSibling && t.nextElementSibling.matches && t.nextElementSibling.matches(panelSel)) return t.nextElementSibling;
  var sibling = t.parentElement && t.parentElement.querySelector(panelSel);
  return sibling || null;
}
function wirePanelToggle(sel, panelSel){
  var els = document.querySelectorAll(sel);
  els.forEach(function(t){
    if(t.dataset.llAccWired) return;
    t.dataset.llAccWired = "1";
    t.addEventListener("click", function(e){
      e.preventDefault(); e.stopPropagation();
      var isOpen = t.getAttribute("aria-expanded") === "true";
      t.setAttribute("aria-expanded", isOpen ? "false" : "true");
      var panel = findPanel(t, panelSel);
      if(panel){ if(isOpen) panel.classList.remove("is-open"); else panel.classList.add("is-open"); }
    }, true);
  });
}
function wireKlensiaFaq(){
  // Re-wire SEMPRE: o sanitizer do storefront substitui nós DOM, invalidando
  // listeners registrados pelo handler nativo (initFaqImgSection) antes do
  // sanitize. O guard data-faq-img-init='true' era falso-positivo — o nativo
  // rodou mas os nós que ele wired já não existem. Guard correto: llAccWired
  // no próprio botão (idempotente por nó, não por seção).
  var els = document.querySelectorAll(".faq-img-question");
  els.forEach(function(t){
    if(t.dataset.llAccWired) return;
    t.dataset.llAccWired = "1";
    t.addEventListener("click", function(){
      var item = t.closest ? t.closest(".faq-img-item") : t.parentElement;
      if(!item) return;
      var answer = item.querySelector(".faq-img-answer");
      var isOpen = item.classList.contains("is-open");
      var group = item.parentElement;
      if(group){
        var siblings = group.querySelectorAll(".faq-img-item.is-open");
        for(var i=0;i<siblings.length;i++){
          if(siblings[i]!==item){
            siblings[i].classList.remove("is-open");
            var sAns = siblings[i].querySelector(".faq-img-answer");
            if(sAns) sAns.style.maxHeight = "0px";
            var sBtn = siblings[i].querySelector(".faq-img-question");
            if(sBtn) sBtn.setAttribute("aria-expanded","false");
          }
        }
      }
      if(isOpen){
        item.classList.remove("is-open");
        t.setAttribute("aria-expanded","false");
        if(answer) answer.style.maxHeight = "0px";
      } else {
        item.classList.add("is-open");
        t.setAttribute("aria-expanded","true");
        if(answer) answer.style.maxHeight = (answer.scrollHeight || 600) + "px";
      }
    });
  });
}
function init(){
  wirePanelToggle(".pss-accordion-trigger", ".pss-accordion-panel");
  wireKlensiaFaq();
  wirePanelToggle(".cc-faq__question", ".cc-faq__answer");
}
if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
var n=0, t=setInterval(function(){ init(); n++; if(n>15) clearInterval(t); }, 300);
})();</script>`);
      logger.info(
        { jobId: job.id, accordionCount: accordionMarkers.length },
        'apply-bundle: accordion universal handler injected',
      );
    }

    // 7.6. PSS Gallery — slider imagens produto do PSS Product Studio (Klensia).
    // Bug: .pss-main-slide renderizado com opacity:1 + position:absolute (todas
    // empilhadas). Trocar classe is-active não muda nada visualmente.
    // Fix: CSS força opacity 0/1 + JS wired em thumbs + arrows + swipe touch mobile.
    // Idempotente. Só injeta se detectar .pss-gallery no DOM.
    $('style[data-landinglab-pss-gallery]').remove();
    $('script[data-landinglab-pss-gallery]').remove();
    if ($('.pss-gallery').length > 0) {
      $('head').append(`<style data-landinglab-pss-gallery>
.pss-main-slide{opacity:0 !important;z-index:0 !important;pointer-events:none !important;transition:opacity .2s ease !important;}
.pss-main-slide.is-active{opacity:1 !important;z-index:2 !important;pointer-events:auto !important;}
.pss-gallery .pss-arrow,.pss-gallery .pss-arrow-prev,.pss-gallery .pss-arrow-next{
  pointer-events:auto !important;cursor:pointer !important;z-index:10 !important;
  position:absolute !important;top:50% !important;transform:translateY(-50%) !important;
  background:rgba(255,255,255,0.92) !important;border:1px solid rgba(0,0,0,0.08) !important;
  border-radius:999px !important;width:40px !important;height:40px !important;
  display:flex !important;align-items:center !important;justify-content:center !important;
  opacity:1 !important;visibility:visible !important;box-shadow:0 2px 6px rgba(0,0,0,0.1) !important;
}
.pss-gallery .pss-arrow-prev{left:8px !important;}
.pss-gallery .pss-arrow-next{right:8px !important;}
.pss-main-slide img{pointer-events:none !important;}
.pss-main-wrap{touch-action:pan-y !important;}
</style>`);
      $('body').append(`<script data-landinglab-pss-gallery>(function(){
function init(){
  var g = document.querySelector(".pss-gallery");
  if(!g || g.dataset.llInit) return;
  var thumbs = g.querySelectorAll(".pss-thumb");
  var slides = g.querySelectorAll(".pss-main-slide");
  var prevBtn = g.querySelector(".pss-arrow-prev");
  var nextBtn = g.querySelector(".pss-arrow-next");
  var mainWrap = g.querySelector(".pss-main-wrap");
  if(!thumbs.length || !slides.length) return;
  g.dataset.llInit = "1";
  function currentIdx(){
    for(var k=0;k<slides.length;k++){ if(slides[k].classList.contains("is-active")) return k; }
    return 0;
  }
  function activate(i){
    var n = slides.length;
    if(i < 0) i = n - 1;
    if(i >= n) i = 0;
    for(var k=0;k<thumbs.length;k++){ thumbs[k].classList.toggle("is-active", k===i); }
    for(var k=0;k<slides.length;k++){ slides[k].classList.toggle("is-active", k===i); }
    if(thumbs[i] && thumbs[i].scrollIntoView){
      try { thumbs[i].scrollIntoView({behavior:"smooth",block:"nearest",inline:"center"}); } catch(_){}
    }
  }
  for(var i=0;i<thumbs.length;i++){
    (function(idx){ thumbs[idx].addEventListener("click",function(e){e.preventDefault();e.stopPropagation();activate(idx);},true); })(i);
  }
  if(prevBtn){
    prevBtn.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();activate(currentIdx()-1);},true);
    prevBtn.style.pointerEvents="auto";prevBtn.disabled=false;
  }
  if(nextBtn){
    nextBtn.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();activate(currentIdx()+1);},true);
    nextBtn.style.pointerEvents="auto";nextBtn.disabled=false;
  }
  if(mainWrap){
    var startX=null,startY=null,startT=0;
    mainWrap.addEventListener("touchstart",function(ev){
      if(!ev.touches||ev.touches.length!==1)return;
      startX=ev.touches[0].clientX;startY=ev.touches[0].clientY;startT=Date.now();
    },{passive:true});
    mainWrap.addEventListener("touchend",function(ev){
      if(startX===null)return;
      var t=(ev.changedTouches&&ev.changedTouches[0])||null;
      if(!t){startX=null;return;}
      var dx=t.clientX-startX,dy=t.clientY-startY,dt=Date.now()-startT;
      startX=startY=null;
      if(dt>800||Math.abs(dx)<30||Math.abs(dx)<Math.abs(dy))return;
      if(dx<0)activate(currentIdx()+1);else activate(currentIdx()-1);
    },{passive:true});
  }
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);
else init();
var n=0,t=setInterval(function(){init();n++;if(n>20)clearInterval(t);},300);
})();</script>`);
      logger.info({ jobId: job.id }, 'apply-bundle: PSS gallery fix injected');
    }

    // 7.7. Remove bloco nativo "PURCHASE OPTIONS / One-time / Subscribe & save" do Kaching.
    // Esse bloco conflita visualmente com o Blackshop subs widget (§7.4).
    // Remove do DOM (alinhado com kaching.ts do cloner). CSS hide removido também.
    // Scripts kaching-subscriptions são removidos pois recriam o widget em runtime
    // mesmo após remoção do elemento estático.
    $('style[data-landinglab-hide-kaching-subs]').remove();
    const kachingSubsRemoved = $('.kaching-bundles__subscriptions').length;
    $('.kaching-bundles__subscriptions').remove();
    $('script[src*="kaching-subscriptions"]').remove();
    $('script#kaching-subscriptions-config').remove();
    if (kachingSubsRemoved > 0) {
      logger.info({ jobId: job.id }, 'apply-bundle: removed native Kaching subs block from DOM');
    }

    // 7.8. Esconde cart-drawer aberto no topo (bug universal Shopify themes).
    // <cart-drawer> é custom element hidratado por JS Shopify. Sem hidratação
    // (nosso storefront sanitiza), renderiza aberto empurrando header e main
    // pra baixo — página parece "quebrada em branco" no topo. Fix: força
    // off-canvas via CSS. JS hydration ainda funciona se sobreviver — quando
    // usuário clica ícone carrinho, classe .active/is-open é adicionada e
    // drawer aparece normal.
    $('style[data-landinglab-cart-drawer-fix]').remove();
    if ($('cart-drawer, [is="cart-drawer"]').length > 0) {
      $('head').append(`<style data-landinglab-cart-drawer-fix>
cart-drawer,.drawer.cart-drawer,[is="cart-drawer"]{
  position:fixed !important;top:0 !important;right:0 !important;
  height:100vh !important;max-width:400px !important;
  transform:translateX(100%) !important;transition:transform .3s ease !important;
  z-index:9999 !important;visibility:hidden !important;
}
cart-drawer.active,cart-drawer.is-open,cart-drawer[open],.drawer.cart-drawer.active{
  transform:translateX(0) !important;visibility:visible !important;
}
</style>`);
      logger.info({ jobId: job.id }, 'apply-bundle: forced cart-drawer off-canvas');
    }

    // 7.9. Feedback visual pro bundle selecionado (Kaching + Aurivita PDP).
    // Sem esse CSS, usuário clica no bundle mas nada muda visualmente. Nosso
    // Engine V2 seta data-landing-variant-active="true" no card clicado —
    // aqui adicionamos borda verde + fundo verde claro + shadow.
    // Neutraliza também --selected nativo do Kaching quando não bate com nosso
    // data-active (evita duplo destaque).
    $('style[data-landinglab-bundle-selected-visual]').remove();
    const hasBundleCards =
      $('.kaching-bundles__bar[data-deal-bar-id]').length > 0 ||
      $('button.cc-pdp-offer').length > 0;
    if (hasBundleCards) {
      $('head').append(`<style data-landinglab-bundle-selected-visual>
/* Base: bordas cinza + hover suave */
.kaching-bundles__bar[data-deal-bar-id],button.cc-pdp-offer{
  border:2px solid rgba(0,0,0,0.15) !important;border-radius:10px !important;
  padding:12px !important;transition:border-color .2s,background-color .2s,box-shadow .2s !important;
  cursor:pointer !important;
}
.kaching-bundles__bar[data-deal-bar-id]:hover,button.cc-pdp-offer:hover{
  border-color:rgba(0,0,0,0.35) !important;background-color:rgba(0,0,0,0.02) !important;
}
/* Neutraliza destaque nativo do Kaching quando NÃO bate com nosso active */
.kaching-bundles__bar--selected:not([data-landing-variant-active="true"]){
  border-color:rgba(0,0,0,0.15) !important;background-color:transparent !important;box-shadow:none !important;
}
/* Bundle ATIVO (nosso Engine V2): borda + fundo + shadow verde */
.kaching-bundles__bar[data-landing-variant-active="true"],
.kaching-bundles__bar[data-landing-variant-active="true"]:hover,
button.cc-pdp-offer[data-landing-variant-active="true"],
button.cc-pdp-offer[data-landing-variant-active="true"]:hover{
  border-color:#004a2f !important;background-color:#eef7ef !important;
  box-shadow:0 4px 12px rgba(0,74,47,0.25) !important;
}
/* Container interno também pega bg verde (Kaching tem wrappers brancos que cobrem) */
.kaching-bundles__bar[data-landing-variant-active="true"] .kaching-bundles__bar-container,
.kaching-bundles__bar[data-landing-variant-active="true"] .kaching-bundles__bar-wrapper,
.kaching-bundles__bar[data-landing-variant-active="true"] .kaching-bundles__bar-main{
  background-color:#eef7ef !important;
}
</style>`);
      logger.info({ jobId: job.id }, 'apply-bundle: bundle-selected visual feedback CSS injected');
    }

    // Aurivita: o clone ainda traz scripts re-hospedados de Shopify e apps
    // legados. Eles são carregados mesmo depois que os controles locais acima
    // substituem suas funções e podem esgotar a memória do Safari no celular.
    if (landingPageId === '3f6cb682-977c-4c09-9ab0-d1bc6dae2583') {
      // O checkout abre em outro domínio; antecipar seus 143 assets neste
      // clone consome rede antes de o visitante interagir com a oferta.
      $('link[rel="prefetch"]').remove();
      const optimizedSalesImages = [
        '2af02ccf4e82cab5', 'ce4bc31bc7de6287',
        '28495c5bcb791882', 'f705fc6b2eb59f48',
        '5b226bce9ff91d51', '875ed58a333e1e9e',
        'ff51ea114e0c99d9', '72320d8432765484',
      ];
      $('img').each((_, el) => {
        const image = $(el);
        for (const attr of ['src', 'srcset', 'data-src', 'data-srcset', 'base-src'] as const) {
          let value = image.attr(attr);
          if (!value) continue;
          for (const name of optimizedSalesImages) {
            value = value.replaceAll(`${name}.png`, `aurivita-sales-${name}.webp`);
          }
          image.attr(attr, value);
        }
      });
      $('[style]').each((_, el) => {
        const element = $(el);
        let value = element.attr('style') || '';
        for (const name of optimizedSalesImages) {
          value = value.replaceAll(`${name}.png`, `aurivita-sales-${name}.webp`);
        }
        element.attr('style', value);
      });
      $('style[data-landinglab-aurivita-cta-layout]').remove();
      $('head').append(`<style data-landinglab-aurivita-cta-layout>
@media (max-width: 768px) {
  [data-landing-cta="buy"] {
    display: flex !important; flex-direction: column !important;
    align-items: center !important; justify-content: center !important;
    gap: 5px !important; padding: 12px 14px !important;
    height: auto !important; min-height: 0 !important;
  }
  html body [id^="ProductSubmitButton-"][data-landing-cta="buy"] .main-atc__label,
  [data-landing-cta="buy"] .main-atc__label {
    display: grid !important; grid-template-columns: minmax(0, 1fr) !important;
    justify-items: center !important; align-items: center !important;
    width: 100% !important; gap: 3px !important;
    text-align: center !important;
  }
  [data-landing-cta="buy"] .main-atc__label__text {
    display: block !important; width: 100% !important;
    font-size: 16px !important; line-height: 1.2 !important;
    font-weight: 700 !important; white-space: normal !important;
    text-align: center !important;
  }
  [data-landing-cta="buy"] [data-cc-atc-append] {
    display: flex !important; flex-wrap: nowrap !important;
    align-items: baseline !important; justify-content: center !important;
    gap: 10px !important; width: auto !important;
    margin: 0 !important; white-space: nowrap !important;
  }
  [data-landing-cta="buy"] [data-cc-atc-append] > span:not([aria-hidden]) {
    font-size: 17px !important; line-height: 1.2 !important;
    white-space: nowrap !important; margin: 0 !important;
  }
  [data-landing-cta="buy"] .cc-pdp-atc-guarantee {
    width: 100% !important; margin: 2px 0 0 !important;
    padding: 0 !important; gap: 5px !important;
    font-size: 11px !important; line-height: 1.2 !important;
  }
  html body [id^="ProductSubmitButton-"][data-landing-cta="buy"] .cc-pdp-atc-guarantee__text,
  [data-landing-cta="buy"] .cc-pdp-atc-guarantee__text {
    font-size: 11px !important; line-height: 1.2 !important;
    letter-spacing: 0 !important; white-space: normal !important;
    text-align: center !important;
  }
}
@media (max-width: 360px) {
  [data-landing-cta="buy"] .cc-pdp-atc-guarantee,
  html body [id^="ProductSubmitButton-"][data-landing-cta="buy"] .cc-pdp-atc-guarantee__text {
    font-size: 10px !important;
  }
}
</style>`);

      $('style[data-landinglab-aurivita-visual-fixes]').remove();
      $('head').append(`<style data-landinglab-aurivita-visual-fixes>
@media (max-width: 768px) {
  .cc-announcement-bar__inner { padding: 6px 10px !important; }
  .cc-announcement-bar__list {
    width: 100% !important; max-width: 100% !important;
    display: grid !important; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) !important;
    gap: 5px !important; transform: none !important;
  }
  .cc-announcement-bar__item {
    min-width: 0 !important; white-space: normal !important;
    display: flex !important; flex-direction: column !important; align-items: center !important;
    text-align: center !important; font-size: 11px !important;
    line-height: 1.2 !important;
  }
  .cc-announcement-bar__item span { display: block !important; white-space: normal !important; }

  .cc-how-to-take__media { height: auto !important; aspect-ratio: auto !important; }
  .cc-how-to-take__media img {
    display: block !important; width: 100% !important; height: auto !important;
    aspect-ratio: auto !important; object-fit: contain !important;
  }

  .avs__mobile-scroller {
    min-width: 0 !important; overflow-x: auto !important; overflow-y: hidden !important;
    padding-top: 72px !important; margin-top: -72px !important;
    touch-action: pan-x !important; -webkit-overflow-scrolling: touch !important;
  }
  .avs__mobile-track {
    width: max-content !important; max-width: none !important;
    overflow: visible !important;
  }

  .cc-customer-notice__swiper {
    overflow-x: auto !important; overflow-y: hidden !important;
    touch-action: pan-x !important; -webkit-overflow-scrolling: touch !important;
    overscroll-behavior-x: contain !important;
  }
  .cc-customer-notice__stage { margin-bottom: 46px !important; }
  .cc-customer-notice__arrow { display: inline-flex !important; }
  .cc-customer-notice__arrow {
    top: calc(100% + 8px) !important; transform: none !important;
  }
  .cc-customer-notice__arrow--prev { left: 0 !important; }
  .cc-customer-notice__arrow--next { right: 0 !important; }

  .cc-footer__selectors { display: none !important; }
  .cc-footer__section { padding-bottom: 24px !important; }
}
</style>`);
      $('script[data-landinglab-aurivita-review-controls]').remove();
      $('body').append(`<script data-landinglab-aurivita-review-controls>(function(){
  function init(){
    if (window.innerWidth > 768) return;
    var slider = document.querySelector('.cc-customer-notice__swiper');
    if (!slider || slider.dataset.llReviewControls) return;
    var slides = Array.prototype.slice.call(slider.querySelectorAll('.swiper-slide'));
    var stage = slider.closest('.cc-customer-notice__stage');
    var prev = stage && stage.querySelector('.cc-customer-notice__arrow--prev');
    var next = stage && stage.querySelector('.cc-customer-notice__arrow--next');
    if (!prev || !next || slides.length < 2) return;
    slider.dataset.llReviewControls = '1';
    [prev, next].forEach(function(button){
      button.disabled = false;
      button.removeAttribute('tabindex');
      button.setAttribute('aria-disabled', 'false');
      button.classList.remove('swiper-button-disabled', 'swiper-button-lock');
    });
    function move(direction){
      var current = 0;
      var distance = Infinity;
      slides.forEach(function(slide, index){
        var delta = Math.abs(slide.offsetLeft - slides[0].offsetLeft - slider.scrollLeft);
        if (delta < distance) { distance = delta; current = index; }
      });
      var target = Math.max(0, Math.min(slides.length - 1, current + direction));
      slider.scrollTo({ left: slides[target].offsetLeft - slides[0].offsetLeft, behavior: 'smooth' });
    }
    prev.addEventListener('click', function(event){ event.preventDefault(); event.stopPropagation(); move(-1); }, true);
    next.addEventListener('click', function(event){ event.preventDefault(); event.stopPropagation(); move(1); }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();</script>`);

      $('head script').each((_, el) => {
        const script = $(el);
        if (script.attr('data-landinglab-pixel') !== undefined) return;
        if (script.attr('type') === 'application/ld+json') return;
        script.remove();
      });
      $('body script').each((_, el) => {
        const script = $(el);
        if (Object.keys(el.attribs).some((name) => name.startsWith('data-landinglab'))) return;
        if ((script.html() || '').includes("document.getElementById('cc-section-template--22056914714876__custom_faqs_ALDxdr')")) return;
        script.remove();
      });

      const deferredImages = [
        '.cc-pdp__main-image', '.cc-doctors-see__image', '.cc-cis__image',
        '.cc-timeline__image', '.cc-expert-quote__image', '.cc-faq__image',
      ];
      $(deferredImages.join(',')).each((index, el) => {
        const image = $(el);
        if (image.hasClass('cc-pdp__main-image') && index === 0) return;
        image.attr('loading', 'lazy');
        image.attr('decoding', 'async');
        image.removeAttr('fetchpriority');
      });
    }

    // O advertorial Aurivita mantém dois conjuntos de imagens GemPages.
    // Os nós móveis ainda apontam para o produto original Metabolae; os nós
    // desktop já usam as artes Aurivita correspondentes. Mantém o layout móvel
    // e troca somente a mídia para evitar um segundo visual no celular.
    if (landingPageId === 'd2043679-df5e-48fb-b596-7afd97c1a97b') {
      const optimizedMedia = new Map([
        ['40227bc371040643.gif', 'aurivita-animation-optimized.webp'],
        ['7a1ea5b28eaaaf9f.png', 'aurivita-artery-optimized.webp'],
        ['52a577d8f964f6af.png', 'aurivita-option-optimized.webp'],
      ]);
      const mediaPairs = [
        ['metabolae_before_vs_after_insulin.webp', 'd857c5eb724e677d.png', 0],
        ['Metabolae-numbers-with-cinnamon.webp', '7a1ea5b28eaaaf9f.png', 0],
        ['metabolae-john-smith-on-a-walk.webp', '40227bc371040643.gif', 0],
        ['metabolae_cinnamon_in_production.webp', '52a577d8f964f6af.png', 0],
        ['metabolae_cassia_vs_ceylon_cinnamon.webp', 'cc27fb0f0a37963e.png', 0],
        ['metabolae_matthew_reed_fairtrade_farmers.webp', 'd2d575105af299cd.png', 0],
        ['metabolae_matthew_reed_fairtrade_farmers.webp', '7b0778bdbb1b7254.png', 0],
      ] as const;
      for (const [legacyName, desktopName, occurrence] of mediaPairs) {
        const desktop = $('img:not([data-landinglab-adv-mobile-media])')
          .filter((_, el) => {
            const src = $(el).attr('src') || '';
            return src.endsWith(desktopName) || src.endsWith(optimizedMedia.get(desktopName) || desktopName);
          }).first();
        const legacyMatches = $('img').filter((_, el) => ($(el).attr('data-src') || '').endsWith(legacyName));
        const mobile = legacyMatches.eq(occurrence).length
          ? legacyMatches.eq(occurrence)
          : $('img[data-landinglab-adv-mobile-media]').filter((_, el) =>
              $(el).attr('data-landinglab-adv-mobile-media') === desktopName).first();
        if (!desktop.length || !mobile.length) continue;
        // GemPages também usa base-src no carregamento tardio no Safari.
        for (const attr of ['src', 'data-src', 'srcset', 'data-srcset', 'base-src'] as const) {
          const value = desktop.attr(attr);
          if (value) mobile.attr(attr, value);
          else mobile.removeAttr(attr);
        }
        mobile.attr('data-landinglab-adv-mobile-media', desktopName);
        mobile.parent('picture').attr('data-landinglab-adv-mobile-frame', '');
        mobile.attr('style', (mobile.attr('style') || '').replace('--objf:cover', '--objf:contain'));
      }
      // Atualiza os atributos usados pelo carregador tardio do GemPages em
      // ambos os viewports; mantém os nomes originais para reprocessamento.
      $('img').each((_, el) => {
        const image = $(el);
        for (const attr of ['src', 'data-src', 'srcset', 'data-srcset', 'base-src'] as const) {
          let value = image.attr(attr);
          if (!value) continue;
          for (const [original, optimized] of optimizedMedia) {
            value = value.replaceAll(original, optimized);
          }
          image.attr(attr, value);
        }
      });
      $('style[data-landinglab-adv-mobile-media]').remove();
      $('head').append(`<style data-landinglab-adv-mobile-media>
@media (max-width: 767px) {
  picture[data-landinglab-adv-mobile-frame] {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
  }
  img[data-landinglab-adv-mobile-media] {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    height: auto !important;
    max-height: none !important;
    aspect-ratio: auto !important;
    object-fit: contain !important;
  }
}
</style>`);
    }

    // 7.100. Fix Splide circular height — splide-component carousels Dawn/PageFly.
    //
    // ROOT CAUSE: base.css do tema Dawn define `.splide__list { height: 100% }`,
    // mas o `.splide__track` pai não tem height explícita quando NÃO usa
    // data-desktop-adaptive-height / data-mobile-adaptive-height. Sem um valor
    // concreto no pai, o browser resolve a referência circular via scrollHeight
    // (soma de TODOS os slides em row), resultando em ~11114px por carousel.
    //
    // FIX: Override `height: auto` na lista para splide-components sem o atributo
    // adaptive-height. Carousels COM adaptive-height têm seu track gerenciado pelo
    // SplideComponent.setActiveSlideHeight() — esses ficam intactos.
    //
    // GENERIC: aplica a qualquer clone com splide-component (Dawn + PageFly +
    // qualquer tema que use a mesma lib). Idempotente via data-attr guard.
    if ($('splide-component').length > 0) {
      $('style[data-landinglab-splide-height-fix]').remove();
      $('head').append(`<style data-landinglab-splide-height-fix>
splide-component:not([data-desktop-adaptive-height]):not([data-mobile-adaptive-height]) .splide__list {
  height: auto !important;
}
splide-component:not([data-desktop-adaptive-height]):not([data-mobile-adaptive-height]) .splide__track {
  height: auto !important;
  overflow: hidden !important;
}
</style>`);
    }

    // 7.99. Força moeda da landing em todo config Shopify embutido no HTML.
    //
    // Fase 9D (26/09/2026): extração cirúrgica pra apps/worker/src/lib/render-currency-config.ts.
    // COMPORTAMENTO IDÊNTICO ao inline pré-9D — mesmas 5 regexes, mesma ordem,
    // mesmo condicional pra fallback. Regex fallback #5 (TD-8.5) preservada.
    //
    // Log inclui { renderer: 'renderCurrencyConfig' } como RUNTIME EVIDENCE
    // (mesmo padrão das Fases 9B/9C).
    const targetCurrency = (page.currency ?? 'EUR').toUpperCase();
    const currencyResult = renderCurrencyConfig($.html(), {
      targetCurrency,
      currencySymbol,
    });
    const html = currencyResult.html;
    const bytesAfter = html.length;
    logger.info(
      {
        jobId: job.id,
        targetCurrency,
        currencySymbol,
        configRewrites: currencyResult.configRewrites,
        deltaBytes: currencyResult.deltaBytes,
        renderer: 'renderCurrencyConfig', // Runtime evidence (Fase 9D)
      },
      'apply-bundle: forced currency in Shopify config + residual price spans',
    );

    logger.info(
      { jobId: job.id, landingPageId, bytesBefore, bytesAfter },
      'apply-bundle: about to run html-safety check',
    );

    // 8. UPDATE landing_pages (protegido por html-safety — Fase 6)
    //
    // Wrappa a mutação completa (page.htmlBody → html) com validação:
    //  - HTML final tem <head>+<body>
    //  - imagens preservadas >= 90%
    //  - scripts críticos (data-cc-pdp-*, data-landinglab-*) preservados
    //  - tamanho não encolheu >20%
    // Se validação falhar → NÃO SOBRESCREVE html_body, job falha com erro claro,
    // landing continua íntegra pra próxima tentativa.
    const safetyResult = safeApplyHtmlMutation(
      page.htmlBody,
      () => html, // mutação já foi feita cumulativamente em §2-§7
      {
        reason: 'apply-bundle full pipeline',
        actor: `worker/apply-bundle:${job.id ?? 'unknown'}`,
        // allowMajorShrink false (default) — proteção contra bug destrutivo
      },
    );

    if (!safetyResult.ok) {
      logger.error(
        {
          jobId: job.id,
          landingPageId,
          code: safetyResult.code,
          reason: safetyResult.reason,
          details: safetyResult.details,
          snapshotSha256: safetyResult.snapshot?.sha256,
        },
        'apply-bundle: HTML safety check REJEITOU mutação — html_body NÃO foi sobrescrito',
      );
      throw new Error(
        `apply-bundle html-safety: ${safetyResult.code} — ${safetyResult.reason}`,
      );
    }

    if (safetyResult.warnings.length > 0) {
      logger.warn(
        { jobId: job.id, landingPageId, warnings: safetyResult.warnings },
        'apply-bundle: HTML safety emitiu warnings (não bloqueia, mas revisar)',
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // Fase 9A · Instrumentação passiva de idempotência (26/09/2026).
    //
    // Sem overhead perceptível: só computa SHA + fingerprint e classifica
    // contra o último snapshot desta landing. Nada bloqueia write.
    //
    // Contrato observado:
    //   se o snapshot anterior tem MESMO dataFingerprint e sha256After
    //   BATE com o sha256 atual → 'idempotent' (bom sinal)
    //   se bate fingerprint mas sha256 diverge → 'diverged' (bug latente!)
    // ─────────────────────────────────────────────────────────────────
    const bytesNew = safetyResult.newHtml.length;
    const sha256AfterCurrent = sha256Hex(safetyResult.newHtml);
    const dataFingerprintCurrent = fingerprintRenderData({
      currency: (page.currency ?? 'EUR').toUpperCase(),
      offers: variants.map((v, i) => ({
        position: v.sortOrder ?? i,
        priceCents: Math.round(parseFloat(String(v.price)) * 100) || 0,
        compareAtCents:
          v.compareAtPrice !== null && v.compareAtPrice !== undefined
            ? Math.round(parseFloat(String(v.compareAtPrice)) * 100)
            : null,
        qty: v.quantityOfItems ?? 1,
        variantId: v.mirrorVariantId ?? null,
      })),
    });

    // Busca snapshot anterior desta landing pra classificar idempotência
    let previousAfterSha: string | null = null;
    let previousDataFingerprint: string | null = null;
    try {
      const [prev] = await db
        .select({
          sha256After: landingHtmlSnapshots.sha256After,
          dataFingerprint: landingHtmlSnapshots.dataFingerprint,
        })
        .from(landingHtmlSnapshots)
        .where(eq(landingHtmlSnapshots.landingPageId, landingPageId))
        .orderBy(desc(landingHtmlSnapshots.createdAt))
        .limit(1);
      previousAfterSha = prev?.sha256After ?? null;
      previousDataFingerprint = prev?.dataFingerprint ?? null;
    } catch {
      // silêncio — instrumentação não bloqueia processing
    }
    const idempotencyClass = classifyIdempotency(
      sha256AfterCurrent,
      previousAfterSha,
      dataFingerprintCurrent,
      previousDataFingerprint,
    );
    logger.info(
      {
        jobId: job.id,
        landingPageId,
        idempotencyClass,
        sha256AfterCurrent: sha256AfterCurrent.slice(0, 12),
        previousAfterSha: previousAfterSha ? previousAfterSha.slice(0, 12) : null,
        dataFingerprintCurrent: dataFingerprintCurrent.slice(0, 12),
        previousDataFingerprint: previousDataFingerprint
          ? previousDataFingerprint.slice(0, 12)
          : null,
      },
      'apply-bundle: idempotency classification',
    );
    if (idempotencyClass === 'diverged') {
      logger.warn(
        { jobId: job.id, landingPageId },
        'apply-bundle: RENDER DIVERGIDO — mesmos dados canônicos produziram HTML diferente do último job. Investigar não-determinismo.',
      );
    }

    // Persiste snapshot ANTES do UPDATE — auditoria + rollback (Fase 7).
    // Best-effort: se persist falhar, apenas loga (não bloqueia write).
    const persistResult = await persistSnapshot(
      db as never,
      landingHtmlSnapshots,
      landingPageId,
      safetyResult.snapshot,
      {
        bytesAfter: bytesNew,
        sha256After: sha256AfterCurrent,
        dataFingerprint: dataFingerprintCurrent,
        warnings: safetyResult.warnings,
      },
    );
    if (!persistResult.ok) {
      logger.warn(
        { jobId: job.id, landingPageId, persistError: persistResult.error },
        'apply-bundle: falha ao persistir snapshot (não crítico — segue com update)',
      );
    }

    await db
      .update(landingPages)
      .set({ htmlBody: safetyResult.newHtml, updatedAt: new Date() })
      .where(eq(landingPages.id, landingPageId));

    logger.info(
      {
        jobId: job.id,
        landingPageId,
        variantsBound,
        ctaAnnotated,
        stickyRemoved,
        handlerInjected,
        assetsChecked,
        assetsFixed,
        bytesBefore,
        bytesAfter,
        delta: bytesAfter - bytesBefore,
      },
      'apply-bundle: done',
    );

    return {
      ok: true,
      variantsBound,
      ctaAnnotated,
      stickyRemoved,
      handlerInjected,
      assetsChecked,
      assetsFixed,
      themeAssetsInjected,
      htmlBytesBefore: bytesBefore,
      htmlBytesAfter: bytesAfter,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

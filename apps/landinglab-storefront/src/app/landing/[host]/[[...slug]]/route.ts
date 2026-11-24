// GET /landing/[host]/[[...slug]] — serve o HTML clonado como text/html puro.
//
// IMPORTANTE (correção crítica set/2026):
// Antes esta rota era um `page.tsx` que injetava htmlBody via dangerouslySetInnerHTML
// dentro do <html> do Next.js. Isso quebrava custom elements Shopify
// (<media-gallery>, <slider-component>, <product-form>, <kaching-bundles-block>)
// porque o browser encontrava dois <html> aninhados + DOM inválido.
// Resultado: galeria travada, bundles não clicáveis, botões nativos submetiam
// pra /cart/add e caíam em 404.
//
// Agora: retornamos o HTML completo direto pelo route handler (igual o backoffice
// preview faz). Os custom elements Shopify inicializam normalmente e a UX
// clonada funciona idêntica ao site origem.

import { and, asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { trackingPixels } from '@blackshop/db/schema';
import { landingBundleOffers, landingPixels } from '@blackshop/db/schema-landinglab-core';
import { currencyMinorUnitDigits, minorUnitsToMajor } from '@blackshop/pricing';
import { editsRuntimeScriptFor } from '@blackshop/shared/landing-edits-runtime';

import { ANTI_WIPE_GUARD_SCRIPT } from '@/lib/anti-wipe-guard';
import { buildConsentScript, consentRequired, stripPixelNoscript } from '@/lib/consent-banner';
import { RELABEL_CTA_RUNTIME_JS, SUBSCRIPTION_CENTS_RUNTIME_JS } from '@/lib/cta-runtime';
import { getDb } from '@/lib/db';
import { externalCheckoutHeadScript, prepareLandingHtmlForProvider } from '@/lib/external-checkout-html';
import { applyLandingOffers, fetchOfferExtras, toOfferViews } from '@/lib/landing-offers-html';
import { applyPixelId } from '@/lib/pixel-id';
import { resolveLanding, type ResolvedLanding } from '@/lib/resolve-landing';
import { sanitizeInlineCss, sanitizeLandingHtml } from '@/lib/sanitize-landing-html';
import { THEME_GLOBALS_SHIM_SCRIPT } from '@/lib/theme-globals-shim';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Props {
  params: { host: string; slug?: string[] };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers reutilizados do page.tsx antigo
// ─────────────────────────────────────────────────────────────────────────

function toAbsoluteUrl(host: string, assetPath: string): string {
  if (/^https?:\/\//i.test(assetPath)) return assetPath;
  const normalizedPath = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;
  return `https://${host}${normalizedPath}`;
}

function pickHeroImage(host: string, landing: ResolvedLanding): string | undefined {
  const raw = landing.seoImage ?? landing.mediaUrls[0];
  return raw ? toAbsoluteUrl(host, raw) : undefined;
}

function buildProductJsonLd(
  host: string,
  landing: ResolvedLanding,
  bundleOffers: Array<{ priceCents: number; isPreselected: boolean }> = [],
): string {
  const heroImage = pickHeroImage(host, landing);
  let priceNum = Number(landing.price);

  // Landings Engine V2 tipicamente têm landing_pages.price='0.00' porque o
  // wizard V2 só escreve em landing_bundle_offers. Fallback: usa o preço da
  // oferta pré-selecionada (ou a primeira) para popular o JSON-LD de SEO.
  if ((!Number.isFinite(priceNum) || priceNum <= 0) && bundleOffers.length > 0) {
    const primary = bundleOffers.find((o) => o.isPreselected) ?? bundleOffers[0];
    if (primary && primary.priceCents > 0) {
      priceNum = minorUnitsToMajor(primary.priceCents, landing.currency);
    }
  }

  const hasValidPrice = Number.isFinite(priceNum) && priceNum > 0;

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: landing.seoTitle ?? landing.title,
  };

  if (landing.seoDescription) jsonLd.description = landing.seoDescription;
  if (heroImage) jsonLd.image = heroImage;
  if (landing.manufacturer) jsonLd.brand = { '@type': 'Brand', name: landing.manufacturer };
  if (landing.productType) jsonLd.category = landing.productType;

  if (hasValidPrice) {
    // JSON-LD price: zero-decimal currencies (JPY) → integer string "7980";
    // 2-decimal currencies → "79.80". Google aceita ambos.
    const fractionDigits = currencyMinorUnitDigits(landing.currency);
    jsonLd.offers = {
      '@type': 'Offer',
      price: priceNum.toFixed(fractionDigits),
      priceCurrency: landing.currency,
      availability: 'https://schema.org/InStock',
      url: `https://${host}`,
    };
  }

  return JSON.stringify(jsonLd);
}

// ─────────────────────────────────────────────────────────────────────────
// Meta tags (OpenGraph + hreflang) — injetadas no <head> do HTML clonado.
// ─────────────────────────────────────────────────────────────────────────

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildMetaTags(host: string, landing: ResolvedLanding): string {
  const heroImage = pickHeroImage(host, landing);
  // Canonical = raiz do host (sem path). Para subdomínios isso é correto
  // diretamente. Para path-model (cubipiccanti.online/klensia) o host roteado
  // pelo middleware Vercel já chega como o host completo — sem slug adicional.
  // landing.slug é o slug interno da landing_pages table e não deve ser
  // appended ao host pois criaria URL inexistente.
  const canonicalUrl = `https://${host}`;
  const title = landing.seoTitle ?? landing.title;
  const description = landing.seoDescription ?? '';
  const parts: string[] = [
    `<title>${escapeAttr(title)}</title>`,
    `<meta name="description" content="${escapeAttr(description)}">`,
    `<link rel="canonical" href="${escapeAttr(canonicalUrl)}">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    `<meta property="og:url" content="${escapeAttr(canonicalUrl)}">`,
  ];
  if (heroImage) {
    parts.push(`<meta property="og:image" content="${escapeAttr(heroImage)}">`);
    parts.push(`<meta name="twitter:card" content="summary_large_image">`);
    parts.push(`<meta name="twitter:image" content="${escapeAttr(heroImage)}">`);
  }
  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Bundle Engine V2 — injetor client-side
//
// Fetch das offers do banco (landing_bundle_offers) + script inline que:
//   1. Expõe window.__LL_BUNDLE_OFFERS__ com {position, qty, variantId, ...}.
//   2. MutationObserver aguarda Kaching hidratar [data-deal-bar-id] e anota
//      data-landing-variant-id/data-landing-qty em cada card em ORDEM VISUAL.
//   3. Marca o card correspondente a is_preselected como
//      data-landing-variant-active="true".
//   4. Escuta clicks em [data-deal-bar-id] pra trocar variant ativa.
//   5. Anota data-landing-cta="buy" no botão principal (add-to-cart) e
//      intercepta click/submit → POST /landing-checkout com o
//      shopifyVariantId da variant ativa → redirect pra checkoutUrl Shopify.
//
// Robusto: se offers vier vazio, script não injeta (nenhum override) — landing
// segue comportamento original. Não quebra clonagens sem Engine V2 rodado.
// ─────────────────────────────────────────────────────────────────────────

interface BundleOffer {
  position: number;
  title: string;
  qty: number;
  variantId: string | null;
  priceCents: number;
  compareAtCents: number | null;
  saveText: string | null;
  badge: string | null;
  isPreselected: boolean;
}

// Pixel da landing: override explícito (landing_pixels) ou o pixel de
// Configurações → Tracking. Resolvido a cada request para a troca valer na
// hora em todas as landings, sem reprocessar o HTML.
async function resolvePixelId(landingPageId: string): Promise<string | null> {
  try {
    const db = getDb();
    const [own] = await db
      .select({ pixelId: landingPixels.pixelId })
      .from(landingPixels)
      .where(
        and(
          eq(landingPixels.landingPageId, landingPageId),
          eq(landingPixels.provider, 'meta'),
          eq(landingPixels.isActive, true),
        ),
      )
      .limit(1);
    if (own?.pixelId && /^\d{6,20}$/.test(own.pixelId)) return own.pixelId;
    const [global] = await db
      .select({ pixelId: trackingPixels.pixelId })
      .from(trackingPixels)
      .where(and(eq(trackingPixels.storeId, 'default'), eq(trackingPixels.isActive, true)))
      .orderBy(asc(trackingPixels.createdAt), asc(trackingPixels.id))
      .limit(1);
    return global?.pixelId && /^\d{6,20}$/.test(global.pixelId) ? global.pixelId : null;
  } catch {
    return null;
  }
}

async function fetchBundleOffers(landingPageId: string): Promise<BundleOffer[]> {
  try {
    const db = getDb();
    const rows = await db
      .select({
        position: landingBundleOffers.position,
        title: landingBundleOffers.title,
        qty: landingBundleOffers.qty,
        variantId: landingBundleOffers.variantId,
        priceCents: landingBundleOffers.priceCents,
        compareAtCents: landingBundleOffers.compareAtCents,
        saveText: landingBundleOffers.saveText,
        badge: landingBundleOffers.badge,
        isPreselected: landingBundleOffers.isPreselected,
      })
      .from(landingBundleOffers)
      .where(eq(landingBundleOffers.landingPageId, landingPageId))
      .orderBy(asc(landingBundleOffers.position));
    return rows;
  } catch {
    // Silent fail: se tabela não existe (migration antiga) ou query erra,
    // storefront segue sem Engine V2 (comportamento legado).
    return [];
  }
}

function buildBundleRuntimeScript(
  offers: BundleOffer[],
  shopifyStoreDomain: string,
  landingPageId: string,
  checkoutApiUrl: string,
  currency: string,
  pageTitle: string,
  trackEventApiUrl: string,
  checkoutProvider: 'shopify' | 'stripe' = 'shopify',
): string {
  if (offers.length === 0) return '';

  // Serialize offers pra JS. Escape </script> pra não fechar bloco.
  const offersJson = JSON.stringify(offers).replace(/</g, '\\u003c');
  const storeDomainSafe = JSON.stringify(shopifyStoreDomain);
  // Fase 8D · Landing Lab: currency injetada de landing_pages.currency
  // (fonte única de verdade). Serializada literal pro runtime — usada em
  // fbq('InitiateCheckout', { currency }) e outros trackings.
  const currencySafe = JSON.stringify((currency || 'EUR').toUpperCase());
  // Currency-aware minor-unit divisor: JPY=1 (zero-decimal), USD/EUR=100.
  // Usado pelo fbq pixel pra reportar `value` em major units corretamente.
  const minorUnitDivisor = Math.pow(10, currencyMinorUnitDigits(currency || 'EUR'));
  const pageTitleSafe = JSON.stringify(pageTitle || 'Landing');
  const trackEventApiSafe = JSON.stringify(trackEventApiUrl);

  // Runtime Engine V2. ES5 puro (compat com custom elements Shopify).
  // Estratégia AGRESSIVA — Engine V2 tem prioridade absoluta:
  //   1. Ao carregar, REMOVE scripts antigos (data-landinglab-checkout-handler,
  //      data-landinglab-bundle-select) pra evitar dupla intercepção do CTA.
  //   2. MutationObserver aguarda Kaching hidratar [data-deal-bar-id] e anota
  //      cada card com data-landing-variant-id/qty/position em ordem visual.
  //      Card correspondente a is_preselected recebe data-landing-variant-active.
  //   3. Anota data-landing-cta="buy" no CTA principal (múltiplos seletores).
  //   4. Click no CTA → redirect direto pra
  //      https://{store}.myshopify.com/cart/{variant_id}:1
  //      (Shopify aceita apenas quantidade 1 aqui — a "unidade Shopify" já é
  //      o pack completo. Preço final é o do variant.)
  //   5. Click em card muda variant ativa (sincronizado com --selected do Kaching).
  //
  // Anti-double-fire: __inflight + stopImmediatePropagation impedem clique nativo.
  // Anti-Engine-antiga: __LL_V2_ACTIVE flag global sinaliza pro código legado
  // (checkout-handler) fazer no-op.
  return `<script id="ll-bundle-runtime" data-landinglab-engine="v2">
window.__LL_BUNDLE_OFFERS__ = ${offersJson};
window.__LL_LANDING_PAGE_ID__ = ${JSON.stringify(landingPageId)};
window.__LL_SHOPIFY_STORE_DOMAIN__ = ${storeDomainSafe};
window.__LL_CHECKOUT_API__ = ${JSON.stringify(checkoutApiUrl)};
window.__LL_CURRENCY__ = ${currencySafe};
window.__LL_MINOR_UNIT_DIVISOR__ = ${minorUnitDivisor};
window.__LL_PAGE_TITLE__ = ${pageTitleSafe};
window.__LL_TRACK_EVENT_API__ = ${trackEventApiSafe};
window.__LL_V2_ACTIVE__ = true;
window.__LL_CHECKOUT_PROVIDER__ = ${JSON.stringify(checkoutProvider)};
(function(){
  var OFFERS = window.__LL_BUNDLE_OFFERS__;
  var STORE = window.__LL_SHOPIFY_STORE_DOMAIN__;
  var CURRENCY = window.__LL_CURRENCY__;
  var MINOR_UNIT_DIVISOR = window.__LL_MINOR_UNIT_DIVISOR__ || 100;
  var PAGE_TITLE = window.__LL_PAGE_TITLE__ || 'Landing';
  var TRACK_EVENT_API = window.__LL_TRACK_EVENT_API__ || '';
  var __inflight = false;
  var __viewContentFired = false;

  // ---------- Meta Pixel helpers ----------
  // Fire-and-forget tracking: emite fbq browser + CAPI server-side em paralelo.
  // Dedup via eventID (Meta considera browser+server mesmo eventID = 1 evento).
  function readCookie(name){
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch(_){ return null; }
  }
  function readQueryParam(name){
    try {
      var m = (window.location.search || '').match(new RegExp('[?&]' + name + '=([^&]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch(_){ return null; }
  }
  function newEventId(name){
    var r = (Math.random().toString(36).slice(2) + Date.now().toString(36));
    return 'll-' + name.toLowerCase() + '-' + r;
  }
  function fireEvent(eventName, customData){
    var eventId = newEventId(eventName);
    try {
      if(typeof window.fbq === 'function'){
        window.fbq('track', eventName, customData, { eventID: eventId });
      }
    } catch(_){}
    // CAPI relay (fire-and-forget, keepalive sobrevive navegação). Só após o
    // consentimento do banner — aí o servidor anexa IP + user agent.
    if(TRACK_EVENT_API){
      var sendCapi = function(){
      try {
        var payload = {
          eventName: eventName,
          eventId: eventId,
          content_ids: customData && customData.content_ids,
          content_name: customData && customData.content_name,
          content_type: customData && customData.content_type,
          value: customData && customData.value,
          currency: customData && customData.currency,
          num_items: customData && customData.num_items,
          fbp: readCookie('_fbp'),
          fbc: readCookie('_fbc'),
          fbclid: readQueryParam('fbclid'),
          marketingConsent: true,
          eventSourceUrl: window.location.href
        };
        fetch(TRACK_EVENT_API, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'content-type': 'application/json' },
          keepalive: true,
          body: JSON.stringify(payload)
        }).catch(function(){});
      } catch(_){}
      };
      if(typeof window.__LL_ON_CONSENT__ === 'function') window.__LL_ON_CONSENT__(sendCapi);
    }
    return eventId;
  }

  function trackViewContent(){
    if(__viewContentFired) return;
    __viewContentFired = true;
    var offer = activeOffer();
    if(!offer) return;
    var contentIds = [];
    for(var i=0; i<OFFERS.length; i++){
      if(OFFERS[i].variantId) contentIds.push(String(OFFERS[i].variantId));
    }
    if(contentIds.length === 0) return;
    fireEvent('ViewContent', {
      content_ids: contentIds,
      content_name: PAGE_TITLE,
      content_type: 'product',
      value: offer.priceCents / MINOR_UNIT_DIVISOR,
      currency: CURRENCY
    });
  }

  function trackAddToCart(offer){
    if(!offer || !offer.variantId) return;
    fireEvent('AddToCart', {
      content_ids: [String(offer.variantId)],
      content_name: PAGE_TITLE,
      content_type: 'product',
      value: offer.priceCents / MINOR_UNIT_DIVISOR,
      currency: CURRENCY,
      num_items: offer.qty
    });
  }

  // ---------- Kill script antigo antes que rode ----------
  // Remove scripts injetados pelo worker legado (checkout-handler-injector
  // + bundle-select) — a Engine V2 é source of truth do CTA.
  function killLegacyScripts(){
    var legacy = document.querySelectorAll(
      'script[data-landinglab-checkout-handler], script[data-landinglab-bundle-select]'
    );
    for(var i=0; i<legacy.length; i++){
      legacy[i].parentNode && legacy[i].parentNode.removeChild(legacy[i]);
    }
  }
  killLegacyScripts();

  // ---------- state ----------
  function activeOffer(){
    for(var i=0; i<OFFERS.length; i++){
      if(OFFERS[i].__active) return OFFERS[i];
    }
    // fallback: preselected ou primeira
    for(var j=0; j<OFFERS.length; j++){
      if(OFFERS[j].isPreselected){ OFFERS[j].__active = true; return OFFERS[j]; }
    }
    if(OFFERS[0]) OFFERS[0].__active = true;
    return OFFERS[0] || null;
  }

  function setActive(position){
    for(var i=0; i<OFFERS.length; i++){
      OFFERS[i].__active = (OFFERS[i].position === position);
    }
    var cards = document.querySelectorAll('[data-landing-variant-id]');
    for(var j=0; j<cards.length; j++){
      var cardPos = parseInt(cards[j].getAttribute('data-landing-position'), 10);
      if(cardPos === position){
        cards[j].setAttribute('data-landing-variant-active', 'true');
      } else {
        cards[j].removeAttribute('data-landing-variant-active');
      }
      syncKachingSelected(cards[j], cardPos === position);
    }
    syncCtaPrice();
  }
  // Story 25.1: o bloco de ofertas do sistema avisa a seleção por aqui.
  window.__LL_SET_ACTIVE_OFFER__ = setActive;

  // O destaque visual do card vem da classe --selected do Kaching. Quando o
  // JS do tema quebra no clone, ela fica presa no card pré-selecionado. Só
  // altera quando difere — o MutationObserver abaixo escuta 'class' e
  // reescrever o mesmo valor geraria loop.
  var KACHING_SELECTED = 'kaching-bundles__bar--selected';
  function syncKachingSelected(card, selected){
    if(!card.classList || !card.hasAttribute('data-deal-bar-id')) return;
    var has = card.classList.contains(KACHING_SELECTED);
    if(selected && !has) card.classList.add(KACHING_SELECTED);
    else if(!selected && has) card.classList.remove(KACHING_SELECTED);
  }

  // ---------- CTA price sync ----------
  // Atualiza SOMENTE o texto .button-text do CTA com o preço da oferta ativa.
  // NÃO toca em classes/attrs do Kaching — evita loop com MutationObserver.
  // Formato: "Add to cart - €29.00" (ou JPY sem decimal: "Add to cart - ¥2980").
  var CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', BRL: 'R$', CHF: 'CHF ', CAD: 'C$', AUD: 'A$', PLN: 'zł', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ' };
  // E2E Stripe B-4 (só checkout Stripe): com Subscribe & Save marcado o CTA
  // mostra o preço recorrente (mesmo arredondamento do servidor) e o rótulo
  // do tema em inglês vira o do mercado (data-landing-cta-labels, gravado pelo
  // apply-bundle). Shopify: nada muda.
  var subscriptionCents = ${SUBSCRIPTION_CENTS_RUNTIME_JS};
  var relabelCta = ${RELABEL_CTA_RUNTIME_JS};
  // Cache só depois de achar o atributo: o script roda no <head> e pode ser
  // chamado antes de o botão existir no DOM.
  var __ctaLabels = null;
  function ctaLabels(){
    if(window.__LL_CHECKOUT_PROVIDER__ !== 'stripe') return null;
    if(__ctaLabels) return __ctaLabels;
    var holder = document.querySelector('[data-landing-cta-labels]');
    if(!holder) return null;
    try { __ctaLabels = JSON.parse(holder.getAttribute('data-landing-cta-labels') || 'null'); } catch(_){ __ctaLabels = null; }
    return __ctaLabels;
  }
  function subscriptionPct(){
    if(window.__LL_CHECKOUT_PROVIDER__ !== 'stripe' || !wantsSubscription()) return 0;
    var widget = document.querySelector('[data-landinglab-subs-widget]');
    var pct = parseInt((widget && widget.getAttribute('data-pct')) || '0', 10);
    return pct > 0 && pct < 100 ? pct : 0;
  }
  function formatOfferPrice(offer){
    if(!offer || typeof offer.priceCents !== 'number') return '';
    var sym = CURRENCY_SYMBOLS[CURRENCY] || (CURRENCY || '');
    // Story 15.2: casas decimais vêm do divisor calculado no servidor
    // (currencyMinorUnitDigits) — antes CLP saía com 2 casas.
    var digits = Math.round(Math.log(MINOR_UNIT_DIVISOR) / Math.LN10);
    var major = subscriptionCents(offer.priceCents, subscriptionPct()) / MINOR_UNIT_DIVISOR;
    return sym + major.toFixed(digits);
  }
  function syncCtaPrice(){
    var offer = activeOffer();
    if(!offer) return;
    var priceStr = formatOfferPrice(offer);
    if(!priceStr) return;
    var labels = ctaLabels();
    var ctaEls = document.querySelectorAll(
      '.shop-add-to-cart-button .button-text, .shop-add-to-cart-wrapper .button-text, [data-landing-cta="buy"] .button-text'
    );
    for(var i=0; i<ctaEls.length; i++){
      var el = ctaEls[i];
      if(el.closest && el.closest('[data-ll-lock-text]')) continue;
      var txt = el.textContent || '';
      var dashIdx = txt.lastIndexOf(' - ');
      var base = dashIdx >= 0 ? txt.substring(0, dashIdx) : txt.trim();
      if(!base) base = (el.getAttribute('data-persistent-text') || 'Add to cart');
      if(labels) base = relabelCta(base, labels);
      var next = base + ' - ' + priceStr;
      if(el.textContent !== next) el.textContent = next;
    }
  }
  // Checkbox do widget de assinatura → re-sincroniza o preço do CTA. Escuta
  // só o evento change (sem observer novo: nenhum risco de loop).
  if(window.__LL_CHECKOUT_PROVIDER__ === 'stripe'){
    document.addEventListener('change', function(ev){
      var t = ev.target;
      if(t && t.matches && t.matches('[data-landinglab-subs-check]')) syncCtaPrice();
    }, false);
  }

  // ---------- anota cards Kaching (hidratação async) ----------
  var __annotated = false;
  function annotateBundleCards(){
    if(__annotated) return;
    var bars = document.querySelectorAll('[data-deal-bar-id]');
    if(bars.length === 0){
      // Story 25.1: modo "sistema" — o bloco próprio já vem anotado do servidor.
      if(!document.querySelector('[data-ll-system-offers]')) return;
      __annotated = true;
      var activeCard = document.querySelector('[data-ll-system-offers] [data-landing-variant-active="true"]');
      var activePos = activeCard ? parseInt(activeCard.getAttribute('data-landing-position'), 10) : NaN;
      if(!isNaN(activePos)) setActive(activePos); else syncCtaPrice();
      trackViewContent();
      return;
    }
    var n = Math.min(bars.length, OFFERS.length);
    if(n === 0) return;
    for(var i=0; i<n; i++){
      var bar = bars[i];
      var offer = OFFERS[i];
      if(!offer.variantId) continue;
      bar.setAttribute('data-landing-variant-id', offer.variantId);
      bar.setAttribute('data-landing-qty', String(offer.qty));
      bar.setAttribute('data-landing-position', String(offer.position));
      // Texto do card = oferta cadastrada (o clone traz o título da loja de
      // origem, que pode não bater com quantidade/preço cobrados).
      var titleEl = bar.querySelector('.kaching-bundles__bar-title');
      if(titleEl && offer.title && titleEl.textContent !== offer.title && !titleEl.closest('[data-ll-lock-text]')) titleEl.textContent = offer.title;
      if(offer.isPreselected){
        offer.__active = true;
        bar.setAttribute('data-landing-variant-active', 'true');
      }
      (function(pos){
        bar.addEventListener('click', function(){ setActive(pos); }, false);
      })(offer.position);
    }
    var kachingSelected = document.querySelector('.kaching-bundles__bar--selected[data-landing-position]');
    if(kachingSelected){
      var pos = parseInt(kachingSelected.getAttribute('data-landing-position'), 10);
      if(!isNaN(pos)) setActive(pos);
    }
    __annotated = true;
    // Sync CTA inicial com preço da oferta preselected (ou primeira).
    syncCtaPrice();
    // ViewContent: 1x por page load, assim que offers estão prontas. Idempotente
    // via __viewContentFired flag — múltiplos ticks do interval chamam de novo
    // mas só dispara uma vez.
    trackViewContent();
    var kb = document.querySelector('kaching-bundles, kaching-bundles-block');
    if(kb){
      var obs = new MutationObserver(function(){
        var sel = document.querySelector('.kaching-bundles__bar--selected[data-landing-position]');
        if(sel){
          var p = parseInt(sel.getAttribute('data-landing-position'), 10);
          if(!isNaN(p)) setActive(p);
        }
      });
      obs.observe(kb, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }
  }

  // ---------- CTA principal ----------
  var CTA_SELECTORS = [
    '[data-landing-cta="buy"]',
    'button[name="add"]',
    '.pss-atc-button',
    '.cc-pdp-buy-buttons button',
    '.cc-pdp__buy-cta',
    '[data-atc-button]'
  ];
  function findCtas(){
    var found = [];
    for(var i=0; i<CTA_SELECTORS.length; i++){
      var els = document.querySelectorAll(CTA_SELECTORS[i]);
      for(var j=0; j<els.length; j++){
        if(!els[j].closest('cart-drawer, .cart-drawer')) found.push(els[j]);
      }
    }
    return found;
  }
  function annotateCtas(){
    var ctas = findCtas();
    for(var i=0; i<ctas.length; i++){
      var cta = ctas[i];
      if(cta.__llBound) continue;
      // NUCLEAR: clona o botão pra remover TODOS os event listeners de widgets
      // do tema (PSS ATC, Kaching add-to-cart, form.submit natives). Sem isso,
      // o handler do widget dispara antes/depois e redireciona pro checkout
      // errado (loja origem). Clonar quebra a ligação total.
      var clone = cta.cloneNode(true);
      clone.__llBound = true;
      clone.setAttribute('data-landing-cta', 'buy');
      if(clone.getAttribute('type') === 'submit') clone.setAttribute('type', 'button');
      // Remove aria-haspopup (widget PSS usa isso pra abrir modal)
      clone.removeAttribute('aria-haspopup');
      cta.parentNode && cta.parentNode.replaceChild(clone, cta);
      // Handler direto no clone
      clone.addEventListener('click', function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        if(ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        checkout();
      }, false);
      // Se estiver em form, previne submit também
      var form = clone.closest('form');
      if(form && !form.__llBound){
        form.__llBound = true;
        form.addEventListener('submit', function(ev){
          ev.preventDefault();
          ev.stopPropagation();
          if(ev.stopImmediatePropagation) ev.stopImmediatePropagation();
          checkout();
        }, true);
      }
    }
  }

  // ---------- QUERY STRING FORWARDING ----------
  // Preserva utm_source/medium/campaign/content/term + fbclid pra Shopify checkout
  // (Shopify auto-atribui via cart attributes se query string vier junto).
  function forwardQueryString(url){
    var current = window.location.search;
    if(!current || current === '?') return url;
    var joiner = url.indexOf('?') >= 0 ? '&' : '?';
    return url + joiner + current.slice(1);
  }

  // Story 15.6: checkbox Subscribe & Save (widget §7.4) marcado. Só o
  // booleano vai ao servidor — intervalo, preço e desconto vêm da landing.
  function wantsSubscription(){
    var check = document.querySelector('[data-landinglab-subs-widget] [data-landinglab-subs-check]');
    return !!(check && check.checked);
  }

  // Story 15.3: checkout Stripe próprio. O servidor confere o provider e
  // devolve /checkout/<token>; preço vem do banco pela posição da oferta.
  // Sem fallback para a Shopify (moeda/preço seriam outros).
  function stripeCheckout(offer){
    __inflight = true;
    trackAddToCart(offer);
    fireEvent('InitiateCheckout', {
      content_ids: [String(offer.variantId || ('offer-' + offer.position))],
      content_name: PAGE_TITLE,
      content_type: 'product',
      num_items: offer.qty,
      value: offer.priceCents / MINOR_UNIT_DIVISOR,
      currency: CURRENCY
    });
    var body = {
      landingPageId: window.__LL_LANDING_PAGE_ID__,
      offerPosition: offer.position,
      attribution: {
        fbp: readCookie('_fbp'),
        fbc: readCookie('_fbc'),
        fbclid: readQueryParam('fbclid'),
        utmSource: readQueryParam('utm_source'),
        utmMedium: readQueryParam('utm_medium'),
        utmCampaign: readQueryParam('utm_campaign'),
        utmContent: readQueryParam('utm_content'),
        utmTerm: readQueryParam('utm_term')
      }
    };
    if(wantsSubscription()) body.subscribe = true;
    fetch(window.__LL_CHECKOUT_API__, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r){ return r.json(); }).then(function(d){
      if(d && d.checkoutUrl){
        window.location.assign(d.checkoutUrl);
      } else {
        console.error('[LL V2] checkout Stripe indisponível', d);
        __inflight = false;
      }
    }).catch(function(err){
      console.error('[LL V2] checkout Stripe erro', err);
      __inflight = false;
    });
  }

  function checkout(){
    if(__inflight) return;
    var offer = activeOffer();
    if(offer && window.__LL_CHECKOUT_PROVIDER__ === 'stripe'){
      stripeCheckout(offer);
      return;
    }
    if(!offer || !offer.variantId){
      console.warn('[LL V2] no active offer — check landing_bundle_offers');
      return;
    }
    __inflight = true;
    // Lê selling_plan do widget subs (se ativo)
    var subsInput = document.querySelector('input[name="selling_plan"][data-landinglab-subs-input]');
    var planId = subsInput && subsInput.value && subsInput.value.trim();
    if(planId && planId.indexOf('gid://shopify/SellingPlan/') === 0){
      planId = planId.slice('gid://shopify/SellingPlan/'.length);
    }
    // AddToCart precede InitiateCheckout (Meta best practice: funnel contínuo).
    // Mesma oferta ativa; browser + CAPI relay via fireEvent.
    trackAddToCart(offer);
    // InitiateCheckout: browser + CAPI relay dedup via eventID.
    fireEvent('InitiateCheckout', {
      content_ids: [String(offer.variantId)],
      content_name: PAGE_TITLE,
      content_type: 'product',
      num_items: offer.qty,
      value: offer.priceCents / MINOR_UNIT_DIVISOR,
      currency: CURRENCY
    });
    // Bypassa cart preexistente Kaching/PSS usando /landing-checkout do backend
    // (Storefront API cartCreate — sempre cria cart NOVO com selling_plan).
    // Fallback: permalink direto se backend falhar.
    var landingPageIdEl = document.querySelector('[data-landing-page-id]');
    var landingPageId = landingPageIdEl && landingPageIdEl.getAttribute('data-landing-page-id');
    var body = {
      cartItems: [{
        shopifyVariantId: String(offer.variantId),
        qty: 1
      }],
      landingPageId: landingPageId
    };
    if(planId) body.cartItems[0].sellingPlanId = planId;
    var CHECKOUT_API_URL = window.__LL_CHECKOUT_API__;
    fetch(CHECKOUT_API_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r){ return r.json(); }).then(function(d){
      if(d && d.checkoutUrl){
        window.location.assign(d.checkoutUrl);
      } else {
        // Fallback pro permalink direto (sem selling_plan aplicado)
        console.warn('[LL V2] backend checkout falhou, fallback permalink', d);
        var url = 'https://' + STORE + '/cart/' + offer.variantId + ':1';
        if(planId) url += '?selling_plan=' + encodeURIComponent(planId);
        url = forwardQueryString(url);
        window.location.assign(url);
      }
    }).catch(function(err){
      console.error('[LL V2] checkout error, fallback', err);
      var url = 'https://' + STORE + '/cart/' + offer.variantId + ':1';
      if(planId) url += '?selling_plan=' + encodeURIComponent(planId);
      url = forwardQueryString(url);
      window.location.assign(url);
    });
  }

  // Click global (capture, roda antes do handler nativo)
  document.addEventListener('click', function(ev){
    var t = ev.target;
    while(t && t !== document.body){
      if(t.getAttribute && t.getAttribute('data-landing-cta') === 'buy'){
        ev.preventDefault();
        ev.stopPropagation();
        if(ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        checkout();
        return;
      }
      t = t.parentElement;
    }
  }, true);

  // ---------- init + retries ----------
  function tick(){
    killLegacyScripts(); // repete pra caso worker antigo tenha injetado tardio
    annotateBundleCards();
    annotateCtas();
    // Garante que o preço do CTA reflita a oferta ativa após qualquer re-render
    // (annotateCtas clona o botão perdendo text updates anteriores).
    if(__annotated) syncCtaPrice();
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', tick);
  } else {
    tick();
  }
  var attempts = 0;
  var iv = setInterval(function(){
    tick();
    if(++attempts >= 20 || __annotated) clearInterval(iv);
  }, 250);
})();
</script>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────

export async function GET(req: Request, { params }: Props): Promise<Response> {
  const host = decodeURIComponent(params.host);
  const slug = (params.slug ?? []).join('/');
  const landing = await resolveLanding(host, slug);

  if (!landing) {
    return new NextResponse('Landing não encontrada.', {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const apiBase =
    process.env['NEXT_PUBLIC_API_URL']?.replace(/\/$/, '') ??
    'https://t.authenlondon.com';
  const checkoutApiUrl = `${apiBase}/landing-checkout`;
  // CAPI relay endpoint — browser POSTa aqui para que o backend emita
  // o evento server-side via /tracking/event (dedup via eventID com fbq).
  const trackEventApiUrl = `${apiBase}/tracking/event`;

  const metaTags = buildMetaTags(host, landing);
  const customCss = landing.customCss ? sanitizeInlineCss(landing.customCss) : '';

  // Aplica sanitize defense-in-depth no HTML clonado (remove
  // trackers/frameworks residuais + attrs perigosos).
  const pixelId = await resolvePixelId(landing.landingPageId);
  // Story 16.3: política do tracker do Sphere + (external) remoção do checkout legado.
  const isExternal = landing.checkoutProvider === 'external';
  const sanitizedBase = applyPixelId(
    stripPixelNoscript(
      prepareLandingHtmlForProvider(sanitizeLandingHtml(landing.htmlBody), landing.checkoutProvider, landing.externalCheckout),
    ),
    pixelId,
  );

  // Bundle Engine V2 — carrega offers do banco e injeta runtime que
  // (a) mata scripts antigos e (b) redireciona CTA direto pro cart Shopify
  // https://{store}.myshopify.com/cart/{variant_id}:1 (sem passar por API).
  const shopifyStoreDomain =
    process.env['SHOPIFY_STORE_DOMAIN']?.trim() ??
    process.env['NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN']?.trim() ??
    'authentic-10069.myshopify.com';
  const [bundleOffers, offerExtras] = await Promise.all([
    fetchBundleOffers(landing.landingPageId),
    fetchOfferExtras(landing.landingPageId),
  ]);
  // Story 25.1: modo "sistema" troca o bloco original pelo do sistema (depois do sanitize); o
  // script de ofertas (título/badge/bullets no modo "página" e link por oferta) vale para todo provider.
  const landingOffers = applyLandingOffers(
    sanitizedBase,
    toOfferViews(bundleOffers, offerExtras),
    offerExtras?.source ?? 'page',
    {
      currency: landing.currency,
      locale: landing.marketLocale ?? landing.contentLanguage,
      lang: landing.contentLanguage ?? landing.marketLocale,
      isExternal,
    },
  );
  const sanitized = landingOffers.html;
  // JSON-LD usa bundleOffers para derivar preço canônico quando price='0.00'
  const productJsonLd = buildProductJsonLd(host, landing, bundleOffers);
  // Story 16.3: `external` não usa a Engine V2 (que cria checkout Shopify/Stripe); serve só a
  // navegação direta para o checkout do produtor.
  const bundleRuntimeScript =
    landing.checkoutProvider === 'external'
      ? ''
      : buildBundleRuntimeScript(
          bundleOffers,
          shopifyStoreDomain,
          landing.landingPageId,
          checkoutApiUrl,
          landing.currency,
          landing.seoTitle ?? landing.title ?? 'Landing',
          trackEventApiUrl,
          landing.checkoutProvider,
        );
  // Story 26.1: edições do editor visual (link do botão, texto travado) — antes de ofertas/Engine V2 para o
  // clique capturado no window chegar primeiro e o texto travado não ser sobrescrito.
  const checkoutScripts = `${editsRuntimeScriptFor(sanitized)}${landingOffers.offersScript}
` + (isExternal
    ? externalCheckoutHeadScript(landing.externalCheckout)
    : `<script>window.__LL_CHECKOUT_API__=${JSON.stringify(checkoutApiUrl)};</script>
${bundleRuntimeScript}`);

  // Injeta <meta> SEO + JSON-LD + script de checkout no <head>.
  // Insere logo após <head> pra ficar antes dos scripts do site origem.
  // Instafeed (app Shopify): imagens hotlinkadas do CDN do Instagram dão 403
  // fora da loja de origem — o bloco fica cinza. Esconde o bloco inteiro.
  const hideBrokenWidgetsCss =
    '<style id="ll-hide-broken-widgets">[id*="__instafeed_app_block"],.instafeed-new-layout-container{display:none !important}</style>';

  // Guarda anti-wipe primeiro: tem que rodar antes de qualquer script do tema (kill switch anti-clone).
  // Logo depois, os utilitários globais do Dawn que o tema pode ter perdido (galeria travada).
  const headInjection = `
${ANTI_WIPE_GUARD_SCRIPT}
${THEME_GLOBALS_SHIM_SCRIPT}
${buildConsentScript(landing.marketLocale ?? landing.contentLanguage, {
  // País do visitante (Vercel). Banner só para UE/EEE/UK/CH; desconhecido → banner.
  required: consentRequired(req.headers.get('x-vercel-ip-country')),
})}
${metaTags}
${hideBrokenWidgetsCss}
${customCss ? `<style>${customCss}</style>` : ''}
<script type="application/ld+json">${productJsonLd}</script>
${checkoutScripts}
`;

  let finalHtml: string;
  if (/<head\b[^>]*>/i.test(sanitized)) {
    finalHtml = sanitized.replace(/<head\b[^>]*>/i, (match) => `${match}\n${headInjection}`);
  } else {
    // Sem <head> (fragmento) — envelopa em documento completo
    finalHtml = `<!DOCTYPE html><html><head>${headInjection}</head><body>${sanitized}</body></html>`;
  }

  return new NextResponse(finalHtml, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
    },
  });
}

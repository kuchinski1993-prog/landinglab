// Injeta script inline mínimo pra fazer botões marcados com data-landing-cta="buy"
// dispararem POST /api/landing-checkout e redirect ao Shopify.
//
// Roda no orchestrator DEPOIS de sanitize (que remove todos os <script> não
// json-ld) — este script precisa ficar por último.
//
// Elementos que o runtime detecta:
//   - [data-landing-cta="buy"] → botão de compra (com ou sem variante específica)
//   - [data-landing-variant-id="uuid"] → variante (clique também marca ativa)
//   - [data-landing-page-id="uuid"] → landing origem (pra logs server-side)
//   - [data-landing-qty="N"] → quantidade padrão (default 1)
//
// Fluxo do click:
//   1. Se elemento tem [data-landing-variant-id]:
//      - Marca como variant ativa (data-landing-variant-active="true")
//      - Desmarca outros
//      - Se também tem [data-landing-cta="buy"]: dispara checkout
//   2. Se elemento tem [data-landing-cta="buy"] sem variant específica:
//      - Usa a variant ativa mais recente (ou primeira do DOM se nenhuma)
//      - Dispara checkout
//
// Attribution auto-coletada (respeita LGPD/consent — só lê o que já tá em cookie):
//   - fbclid (query param, tempo de vida da sessão)
//   - _fbp / _fbc (cookies Meta Pixel padrão)
//   - utm_source / medium / campaign / content / term (query params)
//
// Zero deps externas. ES5 puro (compatibilidade máxima com browsers antigos).
// Tamanho: ~1.5KB (não-minificado).

const CHECKOUT_RUNTIME_SCRIPT = `<script>(function(){
  var API = window.__LL_CHECKOUT_API__ || '/api/landing-checkout';
  function readCookie(name){
    var m = document.cookie.match(new RegExp('(?:^|;\\\\s*)' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function readQuery(){
    var out = {};
    var s = window.location.search.slice(1);
    if(!s) return out;
    var parts = s.split('&');
    for(var i=0; i<parts.length; i++){
      var kv = parts[i].split('=');
      if(kv[0]) out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]||'');
    }
    return out;
  }
  function collectAttribution(){
    var q = readQuery();
    var pick = function(k){ return q[k] || readCookie(k) || null; };
    return {
      fbclid: pick('fbclid'),
      fbp: readCookie('_fbp'),
      fbc: readCookie('_fbc'),
      utmSource: pick('utm_source'),
      utmMedium: pick('utm_medium'),
      utmCampaign: pick('utm_campaign'),
      utmContent: pick('utm_content'),
      utmTerm: pick('utm_term')
    };
  }
  function findActiveVariantId(){
    // Prioridade 1: elemento marcado ativo (data-landing-variant-active)
    var active = document.querySelector('[data-landing-variant-active="true"]');
    if(active) return active.getAttribute('data-landing-variant-id');
    // Prioridade 2: primeiro elemento com data-landing-variant-id no DOM
    var first = document.querySelector('[data-landing-variant-id]');
    return first ? first.getAttribute('data-landing-variant-id') : null;
  }
  // Variants Shopify já são "packs" (ex: variant "3 Bags" tem preço €49.99
  // do pack inteiro). Enviar qty > 1 multiplica o preço no Shopify.
  // Sempre qty=1 — o "quantas unidades" está codificado na própria variant.
  // data-landing-qty é só metadado nosso pra AddToCart pixel event (num_items).
  function findActiveQty(){
    return 1;
  }
  function findBundleQtyForPixel(){
    var active = document.querySelector('[data-landing-variant-active="true"]');
    if(active){
      var q = active.getAttribute('data-landing-qty');
      if(q) return parseInt(q, 10) || 1;
    }
    return 1;
  }
  function findLandingPageId(){
    var el = document.querySelector('[data-landing-page-id]');
    return el ? el.getAttribute('data-landing-page-id') : null;
  }
  // Kaching Subscriptions injeta <input type="hidden" name="selling_plan" value="ID">
  // dentro do formulário do bundle ativo, quando o checkbox "Subscribe & Save"
  // está marcado. Pra suportar assinatura, lemos esse input DO FORM do bundle
  // ativo e passamos pro backend, que anexa ao cartCreate do Shopify.
  function findSellingPlanId(){
    // Estratégia 1: form dentro do bundle ativo (Kaching padrão)
    var active = document.querySelector('[data-landing-variant-active="true"]');
    if(active){
      var form = active.closest('form') || active.querySelector('form');
      if(form){
        var inp = form.querySelector('input[name="selling_plan"]');
        if(inp && inp.value) return inp.value;
      }
    }
    // Estratégia 2: qualquer input hidden selling_plan não vazio no DOM
    // (Kaching pode estar fora do form quando bundle é radio)
    var inputs = document.querySelectorAll('input[name="selling_plan"]');
    for(var i=0; i<inputs.length; i++){
      if(inputs[i].value && inputs[i].value.trim() !== ''){
        return inputs[i].value;
      }
    }
    return null;
  }
  function checkout(landingVariantId, qty){
    if(!landingVariantId){
      console.warn('[LL] no landing_variant_id found — configure na UI');
      alert('Este botão ainda não foi configurado. Contate o vendedor.');
      return;
    }
    var sellingPlanId = findSellingPlanId();
    // Dispara fbq('track', 'InitiateCheckout') se pixel Meta estiver injetado.
    // num_items = unidades do pack (bundle 3 Bags = 3 unidades), não qty do checkout.
    try {
      if (typeof window.fbq === 'function') {
        window.fbq('track', 'InitiateCheckout', {
          content_ids: [landingVariantId],
          num_items: findBundleQtyForPixel(),
          subscription: sellingPlanId ? true : false,
        });
      }
    } catch (_) { /* fail silently — pixel não deve bloquear checkout */ }
    var item = { landingVariantId: landingVariantId, qty: qty || 1 };
    if(sellingPlanId) item.sellingPlanId = sellingPlanId;
    var body = {
      cartItems: [item],
      attribution: collectAttribution(),
      landingPageId: findLandingPageId()
    };
    fetch(API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r){ return r.json(); }).then(function(d){
      if(d && d.checkoutUrl){ window.location.assign(d.checkoutUrl); }
      else { console.error('[LL] checkout failed', d); alert('Não foi possível iniciar o pagamento. Tente novamente.'); }
    }).catch(function(e){ console.error('[LL] checkout error', e); alert('Erro de conexão. Tente novamente.'); });
  }
  var lastAddToCartVid = null;
  function fireAddToCart(vid, qty){
    if(!vid || lastAddToCartVid === vid) return;
    lastAddToCartVid = vid;
    try {
      if(typeof window.fbq === 'function'){
        window.fbq('track', 'AddToCart', {
          content_ids: [vid],
          num_items: qty || 1,
        });
      }
    } catch(_) {}
  }
  // Sincroniza data-landing-variant-active. Prioridade:
  //   1. LandingLab bundle padrão (data-landinglab-bundle="v1") — slot com data-active="true"
  //   2. Kaching Bundles selected (bepurex-style)
  //   3. Qualquer elemento com data-landing-variant-id
  function applyDefaultActive(){
    var pre = document.querySelector('[data-landinglab-bundle="v1"] .ll-bundle__slot[data-active="true"][data-landing-variant-id]');
    if(!pre) pre = document.querySelector('[data-landing-variant-id]:not([data-landing-cta]).kaching-bundles__bar--selected');
    if(!pre) pre = document.querySelector('[data-landing-variant-id]:not([data-landing-cta])');
    if(!pre) return;
    var current = document.querySelector('[data-landing-variant-active="true"]');
    if(current !== pre){
      var all = document.querySelectorAll('[data-landing-variant-id]:not([data-landing-cta])');
      for(var i=0; i<all.length; i++){
        if(all[i] !== pre){
          all[i].removeAttribute('data-landing-variant-active');
          all[i].setAttribute('aria-checked', 'false');
        }
      }
      pre.setAttribute('data-landing-variant-active', 'true');
      pre.setAttribute('aria-checked', 'true');
    }
    var vid = pre.getAttribute('data-landing-variant-id');
    var qty = parseInt(pre.getAttribute('data-landing-qty') || '1', 10);
    if(vid) fireAddToCart(vid, qty);
  }
  function waitForKachingReady(cb){
    // Se for bundle LandingLab (nosso padrão), pronto imediatamente — nosso JS
    // já roda inline e marca data-active="true" no primeiro slot popular.
    if(document.querySelector('[data-landinglab-bundle="v1"]')){ cb(); return; }
    var tries = 0;
    var iv = setInterval(function(){
      tries++;
      var ok = !!document.querySelector('[data-landing-variant-id]:not([data-landing-cta]).kaching-bundles__bar--selected');
      if(ok || tries >= 15){ clearInterval(iv); cb(); }
    }, 200);
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ waitForKachingReady(applyDefaultActive); });
  } else { waitForKachingReady(applyDefaultActive); }
  function observeKachingSelected(){
    var kb = document.querySelector('kaching-bundles');
    if(!kb) { setTimeout(observeKachingSelected, 500); return; }
    var obs = new MutationObserver(function(){ applyDefaultActive(); });
    obs.observe(kb, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }
  observeKachingSelected();
  // Botão universal de comprar (sem variante específica — usa a ativa).
  // CRUCIAL: pega qty do bundle ativo, não do botão. Bundle 5 Bags → qty=5.
  document.addEventListener('click', function(e){
    var target = e.target;
    while(target && target !== document.body){
      if(target.getAttribute && target.getAttribute('data-landing-cta') === 'buy' && !target.getAttribute('data-landing-variant-id')){
        e.preventDefault();
        e.stopPropagation();
        var vid = findActiveVariantId();
        checkout(vid, findActiveQty());
        return;
      }
      target = target.parentElement;
    }
  }, true);
  // Fallback: intercepta submits de formulários /cart/add — se o usuário
  // clicar em algum lugar que ainda submete form, redireciona pro checkout
  document.addEventListener('submit', function(e){
    var form = e.target;
    if(!form || !form.action) return;
    if(form.action.indexOf('/cart/add') !== -1){
      e.preventDefault();
      e.stopPropagation();
      var vid = findActiveVariantId();
      checkout(vid, findActiveQty());
    }
  }, true);
})();</script>`;

// CSS que corrige overflow horizontal comum em landings Shopify mobile.
// Injetado antes de </head> junto com o handler.
const MOBILE_OVERFLOW_FIX_CSS = `<style id="ll-mobile-overflow-fix">
@media (max-width: 767px) {
  html, body { overflow-x: hidden !important; max-width: 100vw !important; }
  .bpx-trust-row { flex-wrap: wrap !important; justify-content: center !important; row-gap: 8px !important; }
  .bpx-trust-item { flex: 0 0 auto !important; }
  .ai-announcement-bar-text, [class*="ai-announcement-bar-text"] {
    max-width: 100% !important; white-space: normal !important;
    word-wrap: break-word !important; box-sizing: border-box !important;
  }
  .cart-timer { max-width: 100% !important; box-sizing: border-box !important; overflow: hidden !important; }
}
/* Swiper mal-inicializado: quando script de config falha, slides empilham
   verticalmente em vez de mostrar horizontal. Força layout de fallback. */
.swiper .swiper-wrapper { max-height: 800px !important; overflow: hidden !important; }
.swiper .swiper-slide { flex-shrink: 0 !important; max-height: 780px !important; overflow: hidden !important; }
/* Cards de review: só flex layout — altura VEM do conteúdo (sem forçar 700px).
   Original aurivita.co usa ~286px altura variável. Compat com mobile 90%. */
.cc-customer-notice__swiper .swiper-wrapper {
  display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important;
}
.cc-customer-notice__swiper .swiper-slide {
  width: 33.33% !important; max-width: 400px !important; height: auto !important;
}
@media (max-width: 767px) {
  .cc-customer-notice__swiper .swiper-slide { width: 90% !important; }
}
</style>`;

// Universal popup killer — remove email-capture / newsletter / exit-intent
// popups (Klaviyo, Shopify padrão, Privy, etc). Landings clonadas herdam esses
// popups do site origem que atrapalham conversão da NOSSA landing.
const POPUP_KILL_CSS = `<style id="ll-popup-kill">
/* Universal popup killer — CSS-only (safe, sem loop JS observer).
   Klaviyo, Shopify promo, Privy, ACA campaigns, exit intent, cookie banners. */
[class*="klaviyo-form"],
[class*="klaviyo-form-version"],
[id*="klaviyo"]:not(script):not(link),
[data-klaviyo-form],
.klaviyo-popup, .klaviyo-modal, .klaviyo-form,
[class*="kl-private-reset-css"], [class*="kl-private"],
.aca-main-wrapper, .aca-container,
#shopify-section-promo-popup,
[id*="section-newsletter-popup"], [id*="section-cookie-banner"],
.promo-popup, .newsletter-popup, .promp-popup__close-btn,
.sign-up-popup-overlay, .sign-up-popup-modal,
.success-popup-overlay, .success-popup-modal,
.popup-overlay,
#sc-subscribe-popup, .sc-popup-overlay,
[id^="alia-root-"], [id^="alia-popup-root-"],
promo-popup, newsletter-popup,
.exit-intent-overlay, .age-gate-overlay, .cookie-consent-banner {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
  z-index: -1 !important;
  position: absolute !important;
  width: 0 !important; height: 0 !important;
  clip: rect(0,0,0,0) !important;
  overflow: hidden !important;
}
/* Klaviyo trava body scroll — libera pra qualquer variante do class name */
body[class*="klaviyo-prevent"] {
  overflow: auto !important;
  overflow-y: visible !important;
  position: static !important;
  padding-right: 0 !important;
}
/* IMPORTANTE: html NÃO deve ter overflow auto pq iOS Safari com html{height:100%}
 * cria double-scrollbar + área bg vazando entre seções (faixa preta iPhone real).
 * Só body scrollar. html fica com overflow visible (scroll passa pro window). */
html { overflow-x: hidden !important; overflow-y: visible !important; }
body { overflow-x: hidden !important; overflow-y: auto !important; }
</style>
<script id="ll-popup-kill-script">
(function(){
  function unblockScroll(){
    var body = document.body;
    if (!body) return;
    body.classList.remove('klaviyo-prevent-body-scroll');
    body.classList.remove('klaviyo-prevent-body-scrolling');
    body.style.overflow = 'auto';
    body.style.position = 'static';
    body.style.paddingRight = '0';
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', unblockScroll);
  } else {
    unblockScroll();
  }
  var count = 0;
  var iv = setInterval(function(){
    unblockScroll();
    if (++count >= 10) clearInterval(iv);
  }, 500);
})();
</script>`;

/**
 * Injeta o script de checkout handler antes de </body>. Se HTML não tiver
 * </body>, adiciona no final. Idempotente: skip se script já presente.
 */
export interface InjectCheckoutHandlerOptions {
  /**
   * Story 16.3 — `external`: checkout do produtor. NÃO injeta o script legado
   * (`POST /api/landing-checkout` / `__LL_CHECKOUT_API__`); o storefront serve, no
   * request, o script de navegação direta com o mapa kit->URL validado de
   * `cta_config.externalCheckout` (`@blackshop/shared/external-checkout`), que fica
   * sempre atual sem re-clonar. CSS mobile e popup killer continuam.
   */
  provider?: 'shopify' | 'stripe' | 'external';
}

export function injectCheckoutHandler(html: string, opts: InjectCheckoutHandlerOptions = {}): string {
  let out = html;
  // Injeta CSS mobile fix antes de </head> (uma vez só — idempotente)
  if (!out.includes('id="ll-mobile-overflow-fix"') && out.includes('</head>')) {
    out = out.replace('</head>', `${MOBILE_OVERFLOW_FIX_CSS}\n</head>`);
  }
  // Injeta popup killer antes de </head> (idempotente).
  if (!out.includes('id="ll-popup-kill"') && out.includes('</head>')) {
    out = out.replace('</head>', `${POPUP_KILL_CSS}\n</head>`);
  }
  if (opts.provider === 'external') return out;
  if (out.includes('__LL_CHECKOUT_API__')) {
    // Handler já injetado — pula (idempotente)
    return out;
  }
  if (out.includes('</body>')) {
    return out.replace('</body>', `${CHECKOUT_RUNTIME_SCRIPT}</body>`);
  }
  return out + CHECKOUT_RUNTIME_SCRIPT;
}

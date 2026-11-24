// LandingLab Bundle Injector — substitui o bundle da landing origem pelo
// template PADRÃO do LandingLab.
//
// Rationale: cada landing usa bundle markup diferente (Kaching, custom PDP,
// bepurex-style, etc). Adaptar checkout-handler pra cada seletor é corrida
// infinita. Nosso sistema tem SEU PRÓPRIO bundle inspirado no bepurex:
// 3 slots fixos + highlights + toggle de assinatura opcional.
//
// Fluxo:
//   1. Detecta bundle block original via seletores conhecidos
//      (kaching-bundles-block, .cc-pdp-offer wrapper, .product__variants, etc)
//   2. Substitui pelo HTML padrão marcado com data-landinglab-bundle="v1"
//   3. Cada slot tem data-landing-variant-id (preenchido depois pelo auto-bind)
//   4. Injeta CSS scoped + JS de seleção inline
//
// Zero dependência externa. HTML/CSS puro (nada de framework).
//
// Uso no orchestrator:
//   const html2 = injectLandinglabBundle(html, {
//     bundles: pricingState.bundles,
//     currency: pricingState.currency,
//     subs: pricingState.subs,
//     locale: 'it' | 'pt' | 'en' | ...
//   });

export interface LandinglabBundleSlot {
  name: string;
  description?: string | undefined;
  priceCents: number;
  compareAtPriceCents: number | null;
  quantityUnits: number | null;
  highlight?: 'popular' | 'best' | null | undefined;
}

export interface LandinglabBundleSubs {
  enabled: boolean;
  sellingPlanId: string | null;
  discountPct: number;
}

export interface LandinglabBundleConfig {
  bundles: LandinglabBundleSlot[];
  currency: string;
  subs?: LandinglabBundleSubs;
  /** Locale pra rótulos ("Adicionar ao carrinho", "Assinar e economizar", etc). Default 'en'. */
  locale?: string;
}

// ─── i18n mínimo (só rótulos do bundle) ───────────────────────────────────
const LABELS: Record<string, {
  addToCart: string;
  subscribeAndSave: (pct: number) => string;
  save: string;
  each: string;
  popular: string;
  best: string;
  headerTitle: string;
  headerBadge: string;
  guarantee: string;
  payment: string;
  tested: string;
  freeShipping: string;
  perDay: string;
}> = {
  en: {
    addToCart: 'Add to cart',
    subscribeAndSave: (p) => `Subscribe & Save ${p}%`,
    save: 'Save',
    each: 'each',
    popular: '🔥 Best Seller',
    best: 'Best Value',
    headerTitle: 'Buy 3+, Free Shipping',
    headerBadge: 'Best Offer',
    guarantee: '30 Day Guarantee',
    payment: 'Secure Payment',
    tested: 'Lab Tested',
    freeShipping: 'Free Shipping',
    perDay: '/day',
  },
  it: {
    addToCart: 'Aggiungi al carrello',
    subscribeAndSave: (p) => `Abbonati e risparmia ${p}%`,
    save: 'Risparmia',
    each: 'cad.',
    popular: '🔥 Il più venduto',
    best: 'Miglior offerta',
    headerTitle: 'Acquista 3+, Spedizione Gratuita',
    headerBadge: 'Migliore Offerta',
    guarantee: 'Garanzia 30 Giorni',
    payment: 'Pagamento Sicuro',
    tested: 'Testato in Laboratorio',
    freeShipping: 'Spedizione Gratuita',
    perDay: '/giorno',
  },
  pt: {
    addToCart: 'Adicionar ao carrinho',
    subscribeAndSave: (p) => `Assinar e economizar ${p}%`,
    save: 'Economize',
    each: 'cada',
    popular: '🔥 Mais Vendido',
    best: 'Melhor Oferta',
    headerTitle: 'Compre 3+, Frete Grátis',
    headerBadge: 'Melhor Oferta',
    guarantee: 'Garantia de 30 Dias',
    payment: 'Pagamento Seguro',
    tested: 'Testado em Laboratório',
    freeShipping: 'Frete Grátis',
    perDay: '/dia',
  },
  'pt-BR': {
    addToCart: 'Adicionar ao carrinho',
    subscribeAndSave: (p) => `Assinar e economizar ${p}%`,
    save: 'Economize',
    each: 'cada',
    popular: '🔥 Mais Vendido',
    best: 'Melhor Oferta',
    headerTitle: 'Compre 3+, Frete Grátis',
    headerBadge: 'Melhor Oferta',
    guarantee: 'Garantia de 30 Dias',
    payment: 'Pagamento Seguro',
    tested: 'Testado em Laboratório',
    freeShipping: 'Frete Grátis',
    perDay: '/dia',
  },
  es: {
    addToCart: 'Añadir al carrito',
    subscribeAndSave: (p) => `Suscríbete y ahorra ${p}%`,
    save: 'Ahorra',
    each: 'c/u',
    popular: '🔥 Más Vendido',
    best: 'Mejor Oferta',
    headerTitle: 'Compra 3+, Envío Gratis',
    headerBadge: 'Mejor Oferta',
    guarantee: 'Garantía de 30 Días',
    payment: 'Pago Seguro',
    tested: 'Probado en Laboratorio',
    freeShipping: 'Envío Gratis',
    perDay: '/día',
  },
  fr: {
    addToCart: 'Ajouter au panier',
    subscribeAndSave: (p) => `S’abonner et économiser ${p}%`,
    save: 'Économisez',
    each: 'chacun',
    popular: '🔥 Le plus vendu',
    best: 'Meilleure offre',
    headerTitle: 'Achetez 3+, Livraison Gratuite',
    headerBadge: 'Meilleure Offre',
    guarantee: 'Garantie 30 Jours',
    payment: 'Paiement Sécurisé',
    tested: 'Testé en Laboratoire',
    freeShipping: 'Livraison Gratuite',
    perDay: '/jour',
  },
  de: {
    addToCart: 'In den Warenkorb',
    subscribeAndSave: (p) => `Abonnieren & ${p}% sparen`,
    save: 'Sparen',
    each: 'Stück',
    popular: '🔥 Bestseller',
    best: 'Bestes Angebot',
    headerTitle: 'Kaufen 3+, Kostenloser Versand',
    headerBadge: 'Bestes Angebot',
    guarantee: '30 Tage Garantie',
    payment: 'Sichere Zahlung',
    tested: 'Labor Getestet',
    freeShipping: 'Kostenloser Versand',
    perDay: '/tag',
  },
};

function getLabels(locale: string): (typeof LABELS)['en'] {
  return LABELS[locale] ?? LABELS[locale.split('-')[0] ?? 'en'] ?? LABELS['en']!;
}

// Formata cents → string usando símbolo de moeda apropriado.
function formatPrice(cents: number, currency: string): string {
  const noDecimalCurrencies = new Set(['JPY', 'CLP', 'KRW', 'ISK']);
  const divisor = noDecimalCurrencies.has(currency) ? 1 : 100;
  const val = cents / divisor;
  const symbols: Record<string, string> = {
    BRL: 'R$',
    USD: '$',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    ARS: '$',
    MXN: '$',
    CLP: '$',
    COP: '$',
  };
  const symbol = symbols[currency] ?? currency + ' ';
  const formatted = divisor === 1 ? val.toFixed(0) : val.toFixed(2);
  return `${symbol}${formatted}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Template do bundle padrão LandingLab ─────────────────────────────────

const BUNDLE_STYLES = `
<style data-landinglab-bundle-styles>
.ll-bundle{max-width:560px;margin:32px auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111827;background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.ll-bundle *,.ll-bundle *::before,.ll-bundle *::after{box-sizing:border-box}
.ll-bundle__header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:16px;border-bottom:1px solid #f3f4f6;margin-bottom:20px}
.ll-bundle__title{font-size:16px;font-weight:700;margin:0;color:#111827}
.ll-bundle__header-badge{font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;background:#004a2f;color:#fff;letter-spacing:.02em;text-transform:uppercase;white-space:nowrap}
.ll-bundle__list{display:flex;flex-direction:column;gap:10px}
.ll-bundle__slot{position:relative;border:1.5px solid #e5e7eb;border-radius:10px;padding:14px 16px;cursor:pointer;background:#fff;transition:all .18s ease}
.ll-bundle__slot:hover{border-color:#9ca3af}
.ll-bundle__slot[data-active="true"]{border-color:#004a2f;background:#f0fdf4;box-shadow:0 0 0 1px #004a2f inset}
.ll-bundle__slot[data-highlight="popular"]{border-color:#004a2f}
.ll-bundle__slot[data-highlight="best"]{border-color:#eab308}
.ll-bundle__badge{position:absolute;top:-10px;right:12px;font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;line-height:1.5}
.ll-bundle__badge--popular{background:#004a2f;color:#fff}
.ll-bundle__badge--best{background:#eab308;color:#111827}
.ll-bundle__row{display:flex;align-items:center;gap:14px}
.ll-bundle__radio{width:20px;height:20px;border:1.5px solid #d1d5db;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:#fff;position:relative}
.ll-bundle__slot[data-active="true"] .ll-bundle__radio{border-color:#004a2f}
.ll-bundle__radio::after{content:"";width:10px;height:10px;background:#004a2f;border-radius:50%;opacity:0;transition:opacity .15s}
.ll-bundle__slot[data-active="true"] .ll-bundle__radio::after{opacity:1}
.ll-bundle__info{flex:1;min-width:0}
.ll-bundle__name{font-weight:700;font-size:14px;margin:0 0 2px;color:#111827;line-height:1.35}
.ll-bundle__desc{font-size:12px;color:#6b7280;margin:0;line-height:1.4}
.ll-bundle__each{font-size:11px;color:#6b7280;display:block;margin-top:2px}
.ll-bundle__prices{text-align:right;flex-shrink:0}
.ll-bundle__price{font-weight:700;font-size:16px;color:#111827}
.ll-bundle__compare{font-size:12px;color:#9ca3af;text-decoration:line-through;display:block;margin-top:1px}
.ll-bundle__subs{margin-top:20px;padding:14px 16px;background:#faf6ee;border:1px solid #f0e6d2;border-radius:10px;display:flex;flex-direction:column;gap:8px}
.ll-bundle__subs-row{display:flex;align-items:center;gap:10px}
.ll-bundle__subs input[type=checkbox]{width:18px;height:18px;accent-color:#004a2f;cursor:pointer;flex-shrink:0}
.ll-bundle__subs label{font-size:13px;cursor:pointer;color:#111827;font-weight:700}
.ll-bundle__subs-hint{font-size:11px;color:#6b7280;margin:0 0 0 28px}
.ll-bundle__cta{width:100%;margin-top:18px;padding:16px 20px;background:#004a2f;color:#fff;border:0;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:.05em;cursor:pointer;transition:background .15s;text-transform:uppercase}
.ll-bundle__cta:hover{background:#003920}
.ll-bundle__cta:active{transform:translateY(1px)}
.ll-bundle__trust{display:flex;align-items:center;justify-content:center;gap:20px;margin-top:16px;padding-top:14px;border-top:1px solid #f3f4f6;flex-wrap:wrap}
.ll-bundle__trust-item{display:flex;align-items:center;gap:6px;font-size:11px;color:#6b7280;font-weight:500}
.ll-bundle__trust-item svg{width:14px;height:14px;flex-shrink:0}
.ll-bundle__shipping{display:flex;gap:8px;margin-top:12px}
.ll-bundle__shipping-box{flex:1;padding:8px 10px;background:#f9fafb;border:1px solid #f3f4f6;border-radius:8px;display:flex;align-items:center;gap:6px;font-size:11px;color:#374151;font-weight:600}
.ll-bundle__shipping-box svg{width:16px;height:16px;color:#004a2f;flex-shrink:0}
@media (max-width:480px){.ll-bundle{margin:20px 12px;padding:18px 14px}.ll-bundle__title{font-size:14px}.ll-bundle__name{font-size:13px}.ll-bundle__price{font-size:15px}.ll-bundle__cta{padding:14px 16px;font-size:14px}.ll-bundle__trust{gap:12px}.ll-bundle__trust-item{font-size:10px}}
</style>`.replace(/\n\s*/g, '');

// Bundle runtime script — string builder, não constante.
// Motivo: bloco subs só é emitido quando toggle habilitado (assim o HTML
// output fica limpo pra teste + reduz peso quando subs=off).
function buildBundleRuntimeScript(withSubs: boolean): string {
  const subsBlock = withSubs
    ? `
  var subsAttr='data-landinglab-subs-'+'check';
  var subsCheck=root.querySelector('['+subsAttr+']');
  var planInput=root.querySelector('input[name="selling_plan"]');
  var planId=root.getAttribute('data-selling-plan-id')||'';
  if(subsCheck&&planInput){
    subsCheck.addEventListener('change',function(){
      planInput.value=subsCheck.checked?planId:'';
    });
  }`
    : '';
  return `<script data-landinglab-bundle-runtime>(function(){
  var root=document.querySelector('[data-landinglab-bundle="v1"]');
  if(!root)return;
  var slots=root.querySelectorAll('[data-slot-index]');
  function setActive(idx){
    for(var i=0;i<slots.length;i++){
      var on=(i===idx);
      slots[i].setAttribute('data-active',on?'true':'false');
      slots[i].setAttribute('data-landing-variant-active',on?'true':'false');
    }
  }
  for(var i=0;i<slots.length;i++){
    (function(idx){
      slots[idx].addEventListener('click',function(e){
        if(e.target&&e.target.closest&&e.target.closest('[data-landing-cta="buy"]'))return;
        setActive(idx);
      });
    })(i);
  }${subsBlock}
  var initial=0;
  for(var j=0;j<slots.length;j++){
    if(slots[j].getAttribute('data-highlight')==='popular'){initial=j;break;}
  }
  setActive(initial);
})();</script>`;
}

function renderSlotHtml(
  slot: LandinglabBundleSlot,
  labels: ReturnType<typeof getLabels>,
  currency: string,
  slotIdx: number,
): string {
  const highlight = slot.highlight ?? null;
  const price = formatPrice(slot.priceCents, currency);
  const compare = slot.compareAtPriceCents != null ? formatPrice(slot.compareAtPriceCents, currency) : '';
  const qty = slot.quantityUnits && slot.quantityUnits > 1 ? slot.quantityUnits : 0;
  const eachPrice = qty > 0 ? formatPrice(Math.round(slot.priceCents / qty), currency) : '';
  const badgeHtml =
    highlight === 'popular'
      ? `<span class="ll-bundle__badge ll-bundle__badge--popular">${escapeHtml(labels.popular)}</span>`
      : highlight === 'best'
        ? `<span class="ll-bundle__badge ll-bundle__badge--best">${escapeHtml(labels.best)}</span>`
        : '';
  return `<div class="ll-bundle__slot" data-slot-index="${slotIdx}" data-highlight="${highlight ?? ''}" data-landing-qty="${qty || 1}">
    ${badgeHtml}
    <div class="ll-bundle__row">
      <div class="ll-bundle__radio"></div>
      <div class="ll-bundle__info">
        <p class="ll-bundle__name">${escapeHtml(slot.name)}</p>
        ${slot.description ? `<p class="ll-bundle__desc">${escapeHtml(slot.description)}</p>` : ''}
        ${eachPrice ? `<span class="ll-bundle__each">${eachPrice} ${escapeHtml(labels.each)}</span>` : ''}
      </div>
      <div class="ll-bundle__prices">
        <span class="ll-bundle__price">${price}</span>
        ${compare ? `<span class="ll-bundle__compare">${compare}</span>` : ''}
      </div>
    </div>
  </div>`;
}

const TRUST_ICONS_SVG = {
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l7 3v6c0 5-3.5 9.5-7 11-3.5-1.5-7-6-7-11V5l7-3z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>',
  flask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3v7l-5 8a2 2 0 002 3h10a2 2 0 002-3l-5-8V3"/><path d="M8 3h8"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="12" height="10"/><path d="M14 10h4l3 3v4h-7z"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/></svg>',
} as const;

export function buildLandinglabBundleHtml(config: LandinglabBundleConfig): string {
  const labels = getLabels(config.locale ?? 'en');
  const slotsHtml = config.bundles
    .map((b, i) => renderSlotHtml(b, labels, config.currency, i))
    .join('');
  const subsEnabled = config.subs?.enabled === true;
  const planId = config.subs?.sellingPlanId ?? '';
  const pct = config.subs?.discountPct ?? 20;
  const subsHtml =
    subsEnabled && planId
      ? `<div class="ll-bundle__subs" data-landinglab-subs>
        <div class="ll-bundle__subs-row">
          <input type="checkbox" id="ll-bundle-subs-check" data-landinglab-subs-check>
          <label for="ll-bundle-subs-check">${escapeHtml(labels.subscribeAndSave(pct))}</label>
        </div>
        <input type="hidden" name="selling_plan" value="">
      </div>`
      : '';

  const headerHtml = `<div class="ll-bundle__header">
    <h3 class="ll-bundle__title">${escapeHtml(labels.headerTitle)}</h3>
    <span class="ll-bundle__header-badge">${escapeHtml(labels.headerBadge)}</span>
  </div>`;

  const shippingHtml = `<div class="ll-bundle__shipping">
    <div class="ll-bundle__shipping-box">${TRUST_ICONS_SVG.truck}<span>${escapeHtml(labels.freeShipping)}</span></div>
    <div class="ll-bundle__shipping-box">${TRUST_ICONS_SVG.shield}<span>${escapeHtml(labels.guarantee)}</span></div>
  </div>`;

  const trustHtml = `<div class="ll-bundle__trust">
    <div class="ll-bundle__trust-item">${TRUST_ICONS_SVG.shield}<span>${escapeHtml(labels.guarantee)}</span></div>
    <div class="ll-bundle__trust-item">${TRUST_ICONS_SVG.lock}<span>${escapeHtml(labels.payment)}</span></div>
    <div class="ll-bundle__trust-item">${TRUST_ICONS_SVG.flask}<span>${escapeHtml(labels.tested)}</span></div>
  </div>`;

  // Anchor pra o checkout-handler-injector achar via [data-landing-cta="buy"]
  const bundleHtml = `${BUNDLE_STYLES}
<div class="ll-bundle" data-landinglab-bundle="v1" data-selling-plan-id="${escapeHtml(planId)}">
  ${headerHtml}
  <div class="ll-bundle__list">${slotsHtml}</div>
  ${subsHtml}
  <button type="button" class="ll-bundle__cta" data-landing-cta="buy">${escapeHtml(labels.addToCart)}</button>
  ${shippingHtml}
  ${trustHtml}
</div>
${buildBundleRuntimeScript(Boolean(subsHtml))}`;

  return bundleHtml;
}

// ─── Detecção + substituição no HTML clonado ─────────────────────────────

/**
 * Seletores de bundle da landing origem (em ordem de preferência).
 * Cada regex captura o BLOCO INTEIRO pra ser substituído.
 *
 * IMPORTANTE: usa regex não-greedy `[\s\S]*?` + balanceamento por tag name
 * (não perfeito mas cobre 95% dos casos). Falha graciosa: se não achou,
 * injeta bundle DEPOIS do primeiro <form action*="/cart"> ou ANTES do
 * primeiro botão de compra.
 */
const BUNDLE_SELECTORS = [
  // Kaching Bundles Block (bepurex)
  /<kaching-bundles-block\b[^>]*>[\s\S]*?<\/kaching-bundles-block>/i,
  // Custom PDP theme (aurivita — .cc-pdp-offer wrapper)
  /<[a-z]+\b[^>]*class="[^"]*cc-pdp-offers?[^"]*"[^>]*>[\s\S]*?<\/[a-z]+>/i,
  // Fastlane / Buy-X-Get-Y bundle
  /<[a-z]+\b[^>]*class="[^"]*(?:bundle-selector|bundle-picker|volume-discount)[^"]*"[^>]*>[\s\S]*?<\/[a-z]+>/i,
  // Genérico: any element with class "bundles" wrapping .bundle items
  /<[a-z]+\b[^>]*class="[^"]*\bbundles\b[^"]*"[^>]*>[\s\S]*?<\/[a-z]+>/i,
];

/**
 * Substitui bundle detectado pelo template LandingLab.
 * Retorna { html, replaced } — replaced=true se conseguiu substituir.
 *
 * Se não achou bundle na landing origem, injeta o template ANTES do primeiro
 * <form> de add-to-cart (Shopify convention) ou próximo ao primeiro CTA.
 */
export function injectLandinglabBundle(
  html: string,
  config: LandinglabBundleConfig,
): { html: string; replaced: boolean; strategy: 'replace' | 'inject-before-form' | 'inject-before-cta' | 'append-body' } {
  if (!config.bundles || config.bundles.length === 0) {
    return { html, replaced: false, strategy: 'append-body' };
  }

  const bundleHtml = buildLandinglabBundleHtml(config);

  // Estratégia 1: substitui bundle detectado
  for (const rx of BUNDLE_SELECTORS) {
    if (rx.test(html)) {
      return { html: html.replace(rx, bundleHtml), replaced: true, strategy: 'replace' };
    }
  }

  // Estratégia 2: injeta antes do primeiro <form action*="/cart">
  const formRx = /<form\b[^>]*action="[^"]*\/cart[^"]*"[^>]*>/i;
  const formMatch = formRx.exec(html);
  if (formMatch) {
    const before = html.slice(0, formMatch.index);
    const after = html.slice(formMatch.index);
    return {
      html: `${before}${bundleHtml}${after}`,
      replaced: true,
      strategy: 'inject-before-form',
    };
  }

  // Estratégia 3: injeta antes do primeiro data-landing-cta="buy" (auto-bind)
  const ctaRx = /<[a-z]+\b[^>]*data-landing-cta="buy"[^>]*>/i;
  const ctaMatch = ctaRx.exec(html);
  if (ctaMatch) {
    const before = html.slice(0, ctaMatch.index);
    const after = html.slice(ctaMatch.index);
    return {
      html: `${before}${bundleHtml}${after}`,
      replaced: true,
      strategy: 'inject-before-cta',
    };
  }

  // Fallback: injeta antes de </body>
  if (html.includes('</body>')) {
    return {
      html: html.replace('</body>', `${bundleHtml}</body>`),
      replaced: true,
      strategy: 'append-body',
    };
  }
  return { html: `${html}${bundleHtml}`, replaced: true, strategy: 'append-body' };
}

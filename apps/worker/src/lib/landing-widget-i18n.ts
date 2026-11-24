// Textos do widget Subscribe & Save e do CTA principal no idioma do mercado
// (E2E Stripe B-3/B-4, out/2026).
//
// - Locale: em landings Stripe o mercado (landing_markets.locale) manda — é o
//   mesmo idioma do checkout e dos e-mails. Shopify mantém a ordem anterior
//   (targetLanguage → <html lang> → en). Fallback sempre 'en' (nunca 'it').
// - Selo do desconto: "15% off" era fixo em inglês.
// - Rótulo do CTA: o tema clonado costuma trazer "Add to cart - €19.00" em
//   inglês. Em landings Stripe trocamos SÓ a frase em inglês conhecida
//   ("Add to cart"/"Add to bag"/"Buy now") pela do mercado, preservando o
//   resto do texto (preço, separador). Texto do tema já traduzido não casa
//   com a regex e fica intacto. Os rótulos vão também no atributo
//   data-landing-cta-labels do CTA: a Engine V2 do storefront (que reescreve
//   o texto do botão a cada troca de oferta) reaplica a mesma troca.

export type WidgetLocale = 'en' | 'it' | 'pt' | 'es' | 'fr' | 'de' | 'ja' | 'zh' | 'ko';

const KNOWN: ReadonlySet<string> = new Set(['en', 'it', 'pt', 'es', 'fr', 'de', 'ja', 'zh', 'ko']);

function lang2(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

export function resolveWidgetLocale(input: {
  checkoutProvider?: string | null;
  marketLocale?: string | null;
  targetLanguage?: string | null;
  htmlLang?: string | null;
}): WidgetLocale {
  const candidates =
    input.checkoutProvider === 'stripe'
      ? [input.marketLocale, input.targetLanguage, input.htmlLang]
      : [input.targetLanguage, input.htmlLang];
  for (const c of candidates) {
    const l = lang2(c);
    if (l) return (KNOWN.has(l) ? l : 'en') as WidgetLocale;
  }
  return 'en';
}

const BADGE: Record<WidgetLocale, (pct: number) => string> = {
  en: (p) => `${p}% off`,
  it: (p) => `Risparmi ${p}%`,
  pt: (p) => `Economize ${p}%`,
  es: (p) => `Ahorra ${p}%`,
  fr: (p) => `-${p}\u00a0%`,
  de: (p) => `${p}\u00a0% sparen`,
  ja: (p) => `${p}%オフ`,
  zh: (p) => `省${p}%`,
  ko: (p) => `${p}% 할인`,
};

/** Selo do desconto da assinatura no idioma do widget. */
export function subsBadgeText(locale: string, pct: number): string {
  const fn = BADGE[(KNOWN.has(locale) ? locale : 'en') as WidgetLocale];
  return fn(pct);
}

export interface CtaLabels {
  addToCart: string;
  buyNow: string;
}

const CTA_LABELS: Record<WidgetLocale, CtaLabels> = {
  en: { addToCart: 'Add to cart', buyNow: 'Buy now' },
  it: { addToCart: 'Aggiungi al carrello', buyNow: 'Acquista ora' },
  pt: { addToCart: 'Adicionar ao carrinho', buyNow: 'Comprar agora' },
  es: { addToCart: 'Añadir al carrito', buyNow: 'Comprar ahora' },
  fr: { addToCart: 'Ajouter au panier', buyNow: 'Acheter maintenant' },
  de: { addToCart: 'In den Warenkorb', buyNow: 'Jetzt kaufen' },
  ja: { addToCart: 'カートに追加', buyNow: '今すぐ購入' },
  zh: { addToCart: '加入购物车', buyNow: '立即购买' },
  ko: { addToCart: '장바구니에 담기', buyNow: '지금 구매' },
};

/** null = não reescrever (inglês, ou landing Shopify/external com texto do tema — Story 16.3). */
export function ctaLabelsFor(locale: string, checkoutProvider: string | null | undefined): CtaLabels | null {
  if (checkoutProvider !== 'stripe') return null;
  if (locale === 'en' || !KNOWN.has(locale)) return null;
  return CTA_LABELS[locale as WidgetLocale];
}

const ADD_RX = /\badd\s+to\s+(?:cart|bag|basket)\b/i;
const BUY_RX = /\bbuy\s+(?:it\s+)?now\b/i;

function keepCase(original: string, label: string): string {
  return original === original.toUpperCase() && original !== original.toLowerCase() ? label.toUpperCase() : label;
}

/**
 * Troca a frase em inglês do CTA pelo rótulo do mercado. Só mexe na frase:
 * "Add to cart - €19.00" → "Aggiungi al carrello - €19.00". Idempotente.
 */
export function relabelCtaText(text: string, labels: CtaLabels): string {
  return text
    .replace(ADD_RX, (m) => keepCase(m, labels.addToCart))
    .replace(BUY_RX, (m) => keepCase(m, labels.buyNow));
}

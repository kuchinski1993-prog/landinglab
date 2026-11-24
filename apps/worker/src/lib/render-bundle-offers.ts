// render-bundle-offers — Fase 9B do Landing Lab Stabilization Roadmap.
//
// Extração cirúrgica da §5 do apply-bundle.processor.ts. REFACTOR, não redesign.
// A lógica interna é IDÊNTICA à versão pré-9B — mesmos seletores, mesma ordem
// de mutação, mesmo fallback. Apenas isolamos em unidade testável.
//
// SE PRECISAR MUDAR LÓGICA aqui, PARE e reporte antes.
//
// Contrato:
//   renderBundleOffers($, options): { variantsBound, pricesRewritten }
//
// A função MUTA o objeto cheerio ($) — same-mutation semantics do processor.
// Retorna counts pra o caller loggar como antes.

import type * as cheerio from 'cheerio';

/**
 * Shape do variant após adaptação em §4 do processor (dual-read
 * bundle_offers → shape interno OU landing_variants legacy).
 * Ver processor linhas 570-620 pra origem.
 */
export interface BundleOfferVariant {
  lvId: string;
  name: string;
  quantityOfItems: number;
  sortOrder: number;
  productId: string | null;
  mirrorVariantId: string | null;
  price: string;
  compareAtPrice: string | null;
}

export interface RenderBundleOffersContext {
  /** Cards detectados (cheerio selection) — caller usa detectBundleCards() */
  cards: cheerio.Cheerio<never>;
  /** Variants a bindar 1:1 nos cards (ordem = ordem visual) */
  variants: BundleOfferVariant[];
  /** Currency da landing — usado pra pixel attr da landing especial 3f6cb682 */
  currency: string;
  /** ID da landing — usado apenas pra check especial da landing 3f6cb682 (pixel attrs) */
  landingPageId: string;
  /** Função de formatação de preço — MESMA usada pelo processor (fmtPrice escopo local) */
  fmtPrice: (val: string | number | null) => string;
}

export interface RenderBundleOffersResult {
  variantsBound: number;
  pricesRewritten: number;
}

/**
 * Extração cirúrgica da §5 do apply-bundle.processor.ts.
 *
 * COMPORTAMENTO IDÊNTICO ao inline pré-9B. Não simplifica nada:
 * - Mesmos seletores multi-tema (Kaching, Aurivita, [data-cc-price], etc)
 * - Mesma lógica de binding N cards ↔ N variants (min entre os dois)
 * - Mesmo tratamento especial pra landing '3f6cb682-...' (pixel attrs)
 * - Mesmo fallback compareStr null (esconde full-price/compare)
 * - Mesmo cálculo de softgels (buyN + freeN × 60)
 * - Mesma injeção de <p class="ll-softs-count">
 *
 * MUTAÇÃO IN-PLACE: função altera o cheerio $ recebido (via
 * context.cards e chamadas $.find/.attr/.text/.remove).
 *
 * Retorna: counts pra observabilidade. Caller loga como antes.
 *
 * @param $ Instância cheerio da landing
 * @param context Contexto extraído explicitamente do processor
 * @returns Counts de binding + reescritas de preço
 */
export function renderBundleOffers(
  $: cheerio.CheerioAPI,
  context: RenderBundleOffersContext,
): RenderBundleOffersResult {
  const { cards, variants, currency, landingPageId, fmtPrice } = context;
  let variantsBound = 0;
  let pricesRewritten = 0;

  if (cards.length === 0 || variants.length === 0) {
    return { variantsBound, pricesRewritten };
  }

  const n = Math.min(cards.length, variants.length);
  for (let i = 0; i < n; i++) {
    const v = variants[i];
    if (!v) continue;
    const card = cards.eq(i);
    card.attr('data-landing-variant-id', v.lvId);
    if (v.mirrorVariantId) card.attr('data-landing-mirror-variant-id', v.mirrorVariantId);
    card.attr('data-landing-qty', String(v.quantityOfItems ?? 1));
    if (landingPageId === '3f6cb682-977c-4c09-9ab0-d1bc6dae2583' && v.productId) {
      card.attr('data-landing-pixel-product-id', v.productId);
      card.attr('data-landing-pixel-value', String(v.price));
      card.attr('data-landing-pixel-currency', (currency ?? 'EUR').toUpperCase());
    }
    variantsBound++;

    // Rewrite preços: substitui preço final e compare (riscado) com valores
    // do banco em EUR (ou moeda do locale). Suporta múltiplos temas:
    //  - Aurivita (cc-pdp-offer): .cc-pdp-offer__price / .cc-pdp-offer__compare
    //  - Kaching Bundles (klensia/bepurex): .kaching-bundles__bar-price /
    //    .kaching-bundles__bar-full-price
    //  - Genéricos [data-cc-price] / [class*="__price"].
    // Se compare_at_price é null no painel, remove o span do riscado (não faz
    // sentido "$179.97" vazio de significado quando o painel só tem "39.99").
    const priceStr = fmtPrice(v.price);
    const compareStr = fmtPrice(v.compareAtPrice);
    if (priceStr) {
      const priceEl = card
        .find(
          [
            '.cc-pdp-offer__price',
            '.kaching-bundles__bar-price',
            '[data-cc-price]',
            '[data-ll-price]',
            '[class*="__price"]:not([class*="compare"]):not([class*="box"]):not([class*="full-price"])',
          ].join(', '),
        )
        .first();
      if (priceEl.length > 0) {
        priceEl.text(priceStr);
        priceEl.attr('data-ll-price', 'locked');
        pricesRewritten++;
      }
    }
    if (compareStr) {
      const compareEl = card
        .find(
          [
            '.cc-pdp-offer__compare',
            '.kaching-bundles__bar-full-price',
            '[data-cc-compare]',
            '[class*="compare"]',
            '[class*="full-price"]',
          ].join(', '),
        )
        .first();
      if (compareEl.length > 0) {
        compareEl.text(compareStr);
        pricesRewritten++;
      }
    } else {
      // Sem compare_at_price no painel → esconde/limpa o full-price/compare
      // pra não vazar valores em USD do clone original.
      card
        .find(
          '.kaching-bundles__bar-full-price, .cc-pdp-offer__compare, [class*="full-price"], [class*="compare"]',
        )
        .each((_, el) => {
          $(el).empty().attr('style', 'display:none !important;');
        });
    }

    // Remove subtitle "Risparmia il 50%" / "Save X%" — economia é irrelevante
    // quando temos price + compare visíveis. Usuario pediu remover explicitamente.
    card
      .find(
        '.cc-pdp-offer__subtitle, .cc-pdp-offer__savings, [class*="__subtitle"], [class*="__savings"]',
      )
      .remove();

    // Adiciona subtitle com contagem de softgels abaixo do "Acquista N".
    // Parse do nome do variant: "Acquista N" ou "Compra N e ricevi M GRATIS"
    // → total_frascos = N + M. Cada frasco = 60 softgels.
    // Ex: "Acquista 1" → 60 softgel · "Compra 2 e ricevi 1 GRATIS" → 180 softgel
    const nameForParse = String(v.name ?? '');
    const buyMatch = nameForParse.match(/(?:Acquista|Compra)\s*(\d+)/i);
    const freeMatch = nameForParse.match(/ricevi\s*(\d+)\s*GRATIS/i);
    const buyN = buyMatch ? parseInt(buyMatch[1] ?? '1', 10) : 1;
    const freeN = freeMatch ? parseInt(freeMatch[1] ?? '0', 10) : 0;
    const totalBottles = buyN + freeN;
    const softgelsPerBottle = 60;
    const totalSoftgels = totalBottles * softgelsPerBottle;
    // Remove qualquer count antigo antes de reinjetar (idempotência).
    card.find('.ll-softs-count').remove();
    const softsHtml = `<p class="ll-softs-count" style="margin:2px 0 0;font-size:12px;line-height:14px;font-weight:400;color:rgba(0,0,0,0.5);">${totalSoftgels} softgel</p>`;
    const titleEl = card.find('.cc-pdp-offer__title, [class*="__title"]').first();
    if (titleEl.length > 0) {
      titleEl.after(softsHtml);
    } else {
      // Fallback: adiciona no fim do meta
      card
        .find('.cc-pdp-offer__meta, [class*="__meta"]')
        .first()
        .append(softsHtml);
    }
  }

  return { variantsBound, pricesRewritten };
}

// render-product-json — Fase 9C do Landing Lab Stabilization Roadmap.
//
// Extração cirúrgica da §5.05 do apply-bundle.processor.ts. REFACTOR, não redesign.
// A lógica interna é IDÊNTICA à versão pré-9C — mesmos seletores, mesmo parse,
// mesma política de erro (JSON inválido → silent skip via try/catch).
//
// SE PRECISAR MUDAR LÓGICA aqui, PARE e reporte antes.
//
// Contexto:
// Tema Aurivita lê <script data-cc-pdp-product-json> pra popular preços dinâmicos
// do CTA (Aggiungi al carrello × qty). Se ficar em USD, o tema sobrescreve os
// valores das /storage/spans em EUR quando o usuário troca bundle/qty.
// Solução original: aqui trocamos currency/moneyFormat/priceFormatted/compareAtPriceFormatted.

import type * as cheerio from 'cheerio';

/**
 * Variant usado como fonte de verdade pra preços no product JSON.
 * Corresponde ao `primaryVariant = variants[0]` no processor.
 */
export interface ProductJsonVariant {
  /** Preço unitário — string decimal (ex: '39.99') ou number */
  price: string | number | null;
  /** Compare-at unitário — string decimal ou number, nullable */
  compareAtPrice: string | number | null;
}

export interface RenderProductJsonContext {
  /** Variant que fornece preço/compare-at do SKU base */
  primaryVariant: ProductJsonVariant;
  /** Currency code UPPERCASE (ex: 'EUR', 'USD') — vai pra data.currency */
  currency: string;
  /** Símbolo da moeda (ex: '€', '$') — vai pra data.moneyFormat */
  currencySymbol: string;
  /** Função de formatação — MESMA usada pelo processor (fmtPrice local) */
  fmtPrice: (val: string | number | null) => string;
}

export interface RenderProductJsonResult {
  /** Quantos <script data-cc-pdp-product-json> foram reescritos com sucesso */
  productJsonRewritten: number;
}

/**
 * Extração cirúrgica da §5.05 do apply-bundle.processor.ts.
 *
 * COMPORTAMENTO IDÊNTICO ao inline pré-9C:
 * - Seletores: 'script[data-cc-pdp-product-json], script[type="application/json"][data-cc-pdp-product-json]'
 * - Skip silencioso se raw HTML vazio (`raw.trim()` falsy)
 * - Skip silencioso via try/catch se JSON.parse falhar (política existente)
 * - Atualiza data.currency + data.moneyFormat
 * - Loop por data.variants: seta price/priceFormatted/compareAtPrice/compareAtPriceFormatted
 * - Loop por v.sellingPlans: mesmo tratamento
 * - Serializa via JSON.stringify (mesma ordem de keys)
 *
 * MUTAÇÃO IN-PLACE do cheerio $.
 * NÃO usa regex global sobre htmlOut — apenas `.html()` interno dos scripts.
 *
 * @param $ Instância cheerio da landing
 * @param context Contexto extraído explicitamente do processor
 * @returns Count de reescritas (0 se JSON inválido/ausente/vazio)
 */
export function renderProductJson(
  $: cheerio.CheerioAPI,
  context: RenderProductJsonContext,
): RenderProductJsonResult {
  const { primaryVariant, currency, currencySymbol, fmtPrice } = context;
  let productJsonRewritten = 0;

  // Se não tem primaryVariant (variants vazio no caller), no-op — mesma política
  // do inline (o caller já protegia com `if (primaryVariant)`).
  if (!primaryVariant) {
    return { productJsonRewritten };
  }

  $(
    'script[data-cc-pdp-product-json], script[type="application/json"][data-cc-pdp-product-json]',
  ).each((_, el) => {
    const raw = $(el).html() || '';
    if (!raw.trim()) return;
    try {
      const data = JSON.parse(raw);
      const rawCurrency = (currency ?? 'EUR').toUpperCase();
      data.currency = rawCurrency;
      // moneyFormat controla como o tema renderiza preços. Usa símbolo do map.
      data.moneyFormat = `${currencySymbol}{{amount}}`;
      // Atualiza cada variant com preço/compare da 1ª landing_variant
      // (representa o SKU base — o tema recalcula em cima).
      const priceCents = Math.round(Number(primaryVariant.price ?? 0) * 100);
      const compareCents = Math.round(Number(primaryVariant.compareAtPrice ?? 0) * 100);
      const priceFmt = fmtPrice(primaryVariant.price);
      const compareFmt = fmtPrice(primaryVariant.compareAtPrice);
      if (data.variants && typeof data.variants === 'object') {
        for (const vid of Object.keys(data.variants)) {
          const v = data.variants[vid];
          v.price = priceCents;
          v.priceFormatted = priceFmt;
          v.compareAtPrice = compareCents;
          v.compareAtPriceFormatted = compareFmt;
          // sellingPlans: tema pode oferecer subscribe & save. Aplica mesmo preço.
          if (v.sellingPlans && typeof v.sellingPlans === 'object') {
            for (const spKey of Object.keys(v.sellingPlans)) {
              const sp = v.sellingPlans[spKey];
              sp.price = priceCents;
              sp.priceFormatted = priceFmt;
              sp.compareAtPrice = compareCents;
              sp.compareAtPriceFormatted = compareFmt;
            }
          }
        }
      }
      $(el).html(JSON.stringify(data));
      productJsonRewritten++;
    } catch {
      /* JSON inválido, ignora */
    }
  });

  return { productJsonRewritten };
}

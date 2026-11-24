// Reescrita de moeda/preço no html_body de uma landing.
// Extraído de api/landing-pages/[id]/edit-html/route.ts (Story 15.2) para ser
// reutilizado ao escolher o mercado da landing — comportamento inalterado.

import * as cheerio from 'cheerio';

export interface SetPriceCurrencyOp {
  operation: 'set-price-currency';
  price?: string; // "39.90" — se omitido, mantém preço atual
  currency?: string; // "EUR" | "USD" | ... — se omitido, mantém moeda atual
}

export interface HandlerResult {
  html: string;
  updatedFields: string[];
  dbPatch?: Record<string, unknown>;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', BRL: 'R$', CAD: 'C$', AUD: 'A$',
  CHF: 'CHF ', JPY: '¥', PLN: 'zł', SEK: 'kr', NOK: 'kr', DKK: 'kr',
};
export function symbolFor(currency: string): string {
  return CURRENCY_SYMBOLS[currency.toUpperCase()] ?? '$';
}

/**
 * SET-PRICE-CURRENCY: reescreve preços em <script product-json> +
 * kaching-bundles-config JSON + spans com class "money". Também atualiza
 * landing_pages.currency + price no DB.
 */
export function applySetPriceCurrency(
  html: string,
  op: SetPriceCurrencyOp,
  currentCurrency: string,
  currentPrice: string,
): HandlerResult & { dbPatch: Record<string, unknown> } {
  const newCurrency = (op.currency ?? currentCurrency).toUpperCase();
  const newPrice = op.price ?? currentPrice;
  const priceNum = Number(newPrice);
  if (!Number.isFinite(priceNum) || priceNum < 0) {
    throw new Error(`Preço inválido: ${newPrice}`);
  }
  const symbol = symbolFor(newCurrency);
  const updatedFields: string[] = [];

  const $ = cheerio.load(html);

  // 1. Reescreve product-json (Shopify + Kaching padrão)
  $('script[data-cc-pdp-product-json], script[type="application/json"]').each((_, el) => {
    const rawContent = $(el).html() || '';
    if (!rawContent.trim().startsWith('{')) return;
    try {
      const data = JSON.parse(rawContent) as Record<string, unknown>;
      let touched = false;
      if ('moneyFormat' in data && typeof data.moneyFormat === 'string') {
        data.moneyFormat = `${symbol}{{amount}}`;
        touched = true;
      }
      if ('currencyRate' in data && typeof data.currencyRate === 'number') {
        // Mantém rate como 1 (assumimos que preço já está na moeda alvo)
        data.currencyRate = 1;
        touched = true;
      }
      if ('marketCurrencyCode' in data && typeof data.marketCurrencyCode === 'string') {
        data.marketCurrencyCode = newCurrency;
        touched = true;
      }
      // product-json Shopify usa 'price' em cents ou 'priceMin'
      const priceCents = Math.round(priceNum * 100);
      if ('price' in data && typeof data.price === 'number') {
        data.price = priceCents;
        touched = true;
      }
      if ('priceMin' in data && typeof data.priceMin === 'number') {
        data.priceMin = priceCents;
        touched = true;
      }
      if ('priceMax' in data && typeof data.priceMax === 'number') {
        data.priceMax = priceCents;
        touched = true;
      }
      // variants[].price também
      if (Array.isArray(data.variants)) {
        for (const v of data.variants) {
          if (v && typeof v === 'object' && 'price' in v && typeof (v as { price: unknown }).price === 'number') {
            (v as { price: number }).price = priceCents;
            touched = true;
          }
        }
      }
      if (touched) {
        $(el).text(JSON.stringify(data));
        updatedFields.push('product-json');
      }
    } catch {
      // silêncio — não é JSON válido
    }
  });

  // 2. Reescreve spans com preço visível (padrão .money, .price-item, etc)
  const priceRegex = /([R$€£¥]|CHF |R\$|C\$|A\$|zł|kr)\s*\d[\d.,]*/g;
  let replacedSpans = 0;
  $('.money, .price-item, [data-price], .cta-price').each((_, el) => {
    const html2 = $(el).html() || '';
    const replaced = html2.replace(priceRegex, `${symbol}${priceNum.toFixed(2)}`);
    if (replaced !== html2) {
      $(el).html(replaced);
      replacedSpans++;
    }
  });
  if (replacedSpans > 0) updatedFields.push(`price-spans (${replacedSpans})`);

  return {
    html: $.html(),
    updatedFields,
    dbPatch: { currency: newCurrency, price: newPrice },
  };
}

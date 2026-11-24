// Story 0.7 · preço por variante para as listas de preço multimoeda.
//
// Antes: o price-sync convertia UM preço (o "a partir de" do produto) e
// mandava o mesmo valor para todas as variantes. Agora cada variante usa o
// próprio `product_variants.price` (moeda-base). Variante sem preço válido
// cai no preço-base do produto (registrado como fallback); valor convertido
// `<= 0` nunca é devolvido para envio.
import { PricingEngine, type PriceRuleInput } from './pricing-engine.js';

export interface VariantPriceSource {
  /** id local (product_variants.id). */
  id: string;
  /** id da variante espelhada na Shopify. */
  mirrorVariantId: string;
  /** product_variants.price (moeda-base); string numeric do Postgres. */
  price: string | number | null;
}

export type VariantPriceFailureCode = 'PRICE_NOT_POSITIVE' | 'NO_BASE_PRICE' | 'PRICING_FAILED';

export interface VariantPricePlan {
  items: Array<{ variantId: string; mirrorVariantId: string; amount: string }>;
  /** Variantes que usaram o preço-base do produto (`variant_price_fallback`). */
  fallbacks: string[];
  failures: Array<{ variantId: string; code: VariantPriceFailureCode; message: string }>;
}

function positiveNumber(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0;
}

/** Converte um preço-base em valor de envio (2 casas). Lança se a regra/preço for inválido. */
export function convertForPriceList(
  engine: PricingEngine,
  basePrice: string | number,
  sourceCurrency: string,
  rule: PriceRuleInput,
  targetCurrency: string,
): string {
  return engine.apply(basePrice, sourceCurrency, rule, targetCurrency).priceBrl.toFixed(2);
}

export function planVariantPrices(params: {
  variants: VariantPriceSource[];
  productBasePrice: string | number | null;
  sourceCurrency: string;
  targetCurrency: string;
  rule: PriceRuleInput;
  engine?: PricingEngine;
}): VariantPricePlan {
  const engine = params.engine ?? new PricingEngine();
  const plan: VariantPricePlan = { items: [], fallbacks: [], failures: [] };

  for (const v of params.variants) {
    let base: string | number;
    if (positiveNumber(v.price)) {
      base = v.price as string | number;
    } else if (positiveNumber(params.productBasePrice)) {
      base = params.productBasePrice as string | number;
      plan.fallbacks.push(v.id);
    } else {
      plan.failures.push({
        variantId: v.id,
        code: 'NO_BASE_PRICE',
        message: 'variante e produto sem preço-base',
      });
      continue;
    }

    let amount: string;
    try {
      amount = convertForPriceList(engine, base, params.sourceCurrency, params.rule, params.targetCurrency);
    } catch (err) {
      plan.failures.push({
        variantId: v.id,
        code: 'PRICING_FAILED',
        message: (err as Error).message,
      });
      continue;
    }
    if (!(Number(amount) > 0)) {
      plan.failures.push({
        variantId: v.id,
        code: 'PRICE_NOT_POSITIVE',
        message: `valor convertido ${amount} não é positivo`,
      });
      continue;
    }
    plan.items.push({ variantId: v.id, mirrorVariantId: v.mirrorVariantId, amount });
  }
  return plan;
}

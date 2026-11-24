export { InvalidExchangeRateError, PricingEngine } from './pricing-engine.js';
export {
  computeChangePct,
  decideRateUpdate,
  FX_DEFAULT_BOOTSTRAP_RANGE,
  FX_DEFAULT_MAX_VARIATION_PERCENT,
  FX_RATE_MAX,
  FX_RATE_MIN,
  FX_SANITY_FACTOR,
  FX_SEED_PLACEHOLDER_RATE,
  isSeedPlaceholder,
  resolveBootstrapRange,
  resolveMaxVariationPercent,
  validateRate,
} from './fx-guard.js';
export type {
  BootstrapRange,
  FxRateInvalidReason,
  RateDecision,
  RateDecisionInput,
  ValidateRateOptions,
  ValidateRateResult,
} from './fx-guard.js';
export { convertForPriceList, planVariantPrices } from './variant-pricing.js';
export type { VariantPriceFailureCode, VariantPricePlan, VariantPriceSource } from './variant-pricing.js';
export type { PriceRuleInput, PricingResult, RoundingStrategy } from './pricing-engine.js';
export { convertPrice, currencySymbol, formatPrice, resolveCurrency } from './format-price.js';
export type { FxRates, StoreCurrency } from './format-price.js';
export { centsToDecimal, currencyMinorUnitDigits, decimalToCents, minorUnitsToMajor } from './cents.js';

export const PRICING_PACKAGE_VERSION = '0.4.0';

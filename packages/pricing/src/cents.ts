// Bloco B · conversão cents ↔ decimal (Fase 8A do Landing Lab Stabilization).
//
// Contexto: landing_bundle_offers.price_cents é integer (cents).
// Consumidores precisam string decimal ('19.99') pra:
//   - Shopify Admin API (input.variants[].price expects 'X.YY')
//   - HTML clonado (span com preço formatado)
//   - JSON inline em <script data-cc-pdp-product-json>
//
// Utilitário puro, zero deps, ESM-safe (import top-level).
// Não usa decimal.js aqui — cents são inteiros, aritmética simples.

/**
 * Converte cents (integer) em string decimal com 2 casas.
 *   2500 → '25.00'
 *   100  → '1.00'
 *   0    → '0.00'
 *
 * Aceita number ou string numérica. Retorna '0.00' pra input inválido
 * (nunca lança — safe pra usar em serialização de HTML).
 */
export function centsToDecimal(cents: number | string | null | undefined): string {
  if (cents === null || cents === undefined) return '0.00';
  const n = typeof cents === 'number' ? cents : parseInt(String(cents), 10);
  if (!Number.isFinite(n)) return '0.00';
  return (n / 100).toFixed(2);
}

/**
 * Converte decimal (number ou string) em cents (integer).
 *   '25.00' → 2500
 *   25.00   → 2500
 *   '25,00' → 2500  (aceita vírgula decimal — locales BR/EU)
 *   '19.99' → 1999
 *   '0.10'  → 10
 *
 * Retorna 0 pra input inválido (nunca lança).
 * Arredonda pra inteiro mais próximo (evita 1999.9999999).
 */
export function decimalToCents(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const normalized =
    typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
  if (!Number.isFinite(normalized)) return 0;
  return Math.round(normalized * 100);
}

/**
 * Retorna o número de dígitos fracionários da moeda (ISO 4217 minor unit exponent).
 * JPY → 0, USD/EUR/BRL → 2, KWD/BHD → 3.
 * Fallback: 2 (comportamento conservador para moeda desconhecida).
 */
export function currencyMinorUnitDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).resolvedOptions().maximumFractionDigits;
    return digits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Converte minor units (integer) para major units (float).
 * JPY: minorUnitsToMajor(7980, 'JPY') → 7980  (divisor=1)
 * USD: minorUnitsToMajor(7980, 'USD') → 79.80  (divisor=100)
 * EUR: minorUnitsToMajor(7980, 'EUR') → 79.80  (divisor=100)
 */
export function minorUnitsToMajor(value: number, currency: string): number {
  const digits = currencyMinorUnitDigits(currency);
  const divisor = Math.pow(10, digits);
  return value / divisor;
}

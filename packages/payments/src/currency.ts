// Casas decimais da Stripe x casas decimais da aplicação (QA 15.3 MNT-004).
//
// A aplicação grava valores em "unidade mínima" segundo o ISO 4217/Intl
// (mesma regra de @blackshop/pricing `currencyMinorUnitDigits`): COP 120.000
// é gravado como 120000. A Stripe tem tabela própria — COP é de duas casas
// na API — então 120000 enviado como está cobraria COP 1.200,00.
// Toda quantia que cruza a fronteira com a Stripe (API e Elements no
// browser) passa por toStripeAmount / fromStripeAmount; o que está gravado
// no banco continua com o mesmo significado.
//
// Fonte: https://docs.stripe.com/currencies (consultada em 2026-10-07).
// Módulo puro — importável pelo storefront via '@blackshop/payments/currency'.

/** Moedas sem casas decimais na API da Stripe (lista oficial). */
export const STRIPE_ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/**
 * Casos especiais documentados: ISK e UGX passaram a ser moedas sem decimais,
 * mas a API exige o valor representado com duas casas terminando em "00"
 * (ISK 5 → 500). HUF e TWD cobram com duas casas. Todas ficam em 2 casas aqui;
 * como a aplicação grava ISK/UGX/HUF sem casas (Intl), a conversão multiplica
 * por 100 e o resultado sempre termina em "00".
 */
export const STRIPE_SPECIAL_TWO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(['ISK', 'UGX', 'HUF', 'TWD']);

/**
 * Três casas decimais (BHD, JOD, KWD, OMR, TND). Não constam da lista de
 * moedas de apresentação atual da Stripe; mantidas em 3 casas por coerência
 * com o ISO 4217 caso passem a ser aceitas.
 */
export const STRIPE_THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** Casas decimais que a Stripe espera em `amount` para a moeda. */
export function stripeCurrencyDigits(currency: string): number {
  const code = currency.toUpperCase();
  if (STRIPE_ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (STRIPE_THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/** Casas decimais com que a aplicação grava a moeda (ISO 4217 via Intl, fallback 2). */
export function appCurrencyDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions()
      .maximumFractionDigits;
    return digits ?? 2;
  } catch {
    return 2;
  }
}

function factorExponent(currency: string): number {
  return stripeCurrencyDigits(currency) - appCurrencyDigits(currency);
}

/** Unidade mínima da aplicação → `amount` da Stripe (ex.: COP 120000 → 12000000). */
export function toStripeAmount(amountMinor: number, currency: string): number {
  const exp = factorExponent(currency);
  if (exp === 0) return amountMinor;
  return Math.round(amountMinor * Math.pow(10, exp));
}

/** `amount` da Stripe → unidade mínima da aplicação (ex.: COP 12000000 → 120000). */
export function fromStripeAmount(amount: number, currency: string): number {
  const exp = factorExponent(currency);
  if (exp === 0) return amount;
  return Math.round(amount / Math.pow(10, exp));
}

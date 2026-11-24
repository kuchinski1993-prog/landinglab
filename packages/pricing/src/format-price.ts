// Bloco A · formatação única de preços.
//
// Uso em servidor (Node) e cliente (browser) — Intl.NumberFormat é
// built-in nos dois. Todos os 19 pontos que hoje fazem
// `new Intl.NumberFormat('pt-BR', { currency: 'BRL' })` devem
// migrar para chamar formatPrice(value, currency).
//
// Regra de fallback: currency ausente/inválida → 'BRL'. Isso preserva
// o comportamento pré-Bloco A para stores que ainda não têm
// stores.settings.currency configurado.

export type StoreCurrency =
  | 'GBP'
  | 'EUR'
  | 'USD'
  | 'BRL'
  | 'CHF'
  | 'UYU'
  // Landing Lab (Fase 8A · 26/09/2026): expandido pra cobrir moedas que
  // o worker apply-bundle já suportava via CURRENCY_SYMBOLS local.
  | 'CAD'
  | 'AUD'
  | 'JPY'
  | 'PLN'
  | 'SEK'
  | 'NOK'
  | 'DKK';

// ISO 4217 aceitos. Qualquer outra string cai no fallback UYU (compat pré-Fase 8).
const SUPPORTED_CURRENCIES: readonly StoreCurrency[] = [
  'GBP', 'EUR', 'USD', 'BRL', 'CHF', 'UYU',
  'CAD', 'AUD', 'JPY', 'PLN', 'SEK', 'NOK', 'DKK',
];

const LOCALE_BY_CURRENCY: Record<StoreCurrency, string> = {
  GBP: 'en-GB',
  // 'de-DE' produz "119,90 €" — separador vírgula, símbolo à direita,
  // padrão neutro para EUR na Europa continental.
  EUR: 'de-DE',
  USD: 'en-US',
  BRL: 'pt-BR',
  // CHF: 'de-CH' produz "CHF 119.90" — padrão suíço (ponto decimal).
  CHF: 'de-CH',
  // UYU: 'es-UY' produz "$ 1.499,99" — símbolo $ à esquerda, ponto milhar, vírgula decimal.
  UYU: 'es-UY',
  // Locales adicionados na Fase 8A. Cada um usa o locale nativo canônico
  // da moeda pra render símbolo + separadores consistentes.
  CAD: 'en-CA',      // "$1,299.99" — dólar canadense em inglês
  AUD: 'en-AU',      // "$1,299.99" — dólar australiano
  JPY: 'ja-JP',      // "¥1,299"    — sem decimais (JPY não tem centavos)
  PLN: 'pl-PL',      // "1299,99 zł" — polonês
  SEK: 'sv-SE',      // "1 299,99 kr" — sueco
  NOK: 'nb-NO',      // "kr 1 299,99" — norueguês
  DKK: 'da-DK',      // "1.299,99 kr" — dinamarquês
};

/**
 * Normaliza qualquer input em uma StoreCurrency válida.
 * Ausente / inválida → 'UYU' (comportamento pré-Fase 8, preservado por compat).
 */
export function resolveCurrency(currency: string | null | undefined): StoreCurrency {
  if (!currency) return 'UYU';
  const upper = currency.toUpperCase();
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(upper)
    ? (upper as StoreCurrency)
    : 'UYU';
}

/**
 * Formata `value` como moeda usando Intl.NumberFormat.
 *
 * - Server-safe (Node ≥14 tem Intl completo).
 * - Client-safe (browsers modernos).
 * - Fallback: currency ausente/inválida → 'BRL'.
 * - Retorna sempre string; não lança exceção.
 */
export function formatPrice(value: number, currency?: string | null): string {
  if (!Number.isFinite(value)) return '';
  const cur = resolveCurrency(currency);
  const locale = LOCALE_BY_CURRENCY[cur];
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: cur,
  }).format(value);
}

// Cache: o Intl.NumberFormat com formatToParts é barato mas repetido em
// labels de formulário — memoiza por moeda para chamar 1x/tempo de vida.
const SYMBOL_CACHE: Partial<Record<StoreCurrency, string>> = {};

/**
 * Devolve o símbolo da moeda no padrão Intl da locale associada.
 *   GBP → "£"    EUR → "€"    USD → "$"    BRL → "R$"
 *
 * Usa `Intl.NumberFormat(...).formatToParts` — reusa a MESMA regra do
 * `formatPrice` para não haver descasamento entre símbolo mostrado num
 * label e símbolo mostrado no valor formatado abaixo.
 *
 * Fallback: input inválido → símbolo do BRL ('R$'), consistente com o
 * fallback do resolveCurrency/formatPrice.
 */
export function currencySymbol(currency?: string | null): string {
  const cur = resolveCurrency(currency);
  const cached = SYMBOL_CACHE[cur];
  if (cached) return cached;
  const locale = LOCALE_BY_CURRENCY[cur];
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: cur,
  }).formatToParts(0);
  // Alguns runtimes emitem 'literal' entre número e símbolo ("R$ ") —
  // pegamos só a parte 'currency' pra ficar limpo em label.
  const symbol = parts.find((p) => p.type === 'currency')?.value ?? cur;
  SYMBOL_CACHE[cur] = symbol;
  return symbol;
}

// ─── Display-only price conversion (Jul/2026) ─────────────────────────────
//
// Motivador: loja opera em uma moeda-base (EUR), mas quer mostrar preços
// pra visitantes de UK em GBP, Suíça em CHF, etc. O valor real cobrado no
// checkout continua sendo em EUR — isso é APENAS conversão de exibição.
//
// Uso:
//   const displayed = convertPrice(49.97, 'EUR', 'GBP', { EUR_TO_GBP: 0.85 })
//   // displayed = 42.47
//
// Se falta cotação (rates[key] undefined) ou moedas iguais → retorna
// o valor cru sem conversão (fallback seguro).

/**
 * Mapa de cotações no formato { EUR_TO_GBP: 0.85, EUR_TO_CHF: 0.96, ... }
 * A chave é sempre `{BASE}_TO_{TARGET}`. Base e target são StoreCurrency.
 */
export type FxRates = Partial<Record<`${StoreCurrency}_TO_${StoreCurrency}`, number>>;

/**
 * Converte um valor de `from` pra `to` usando taxa provida.
 * Retorna o próprio valor se moedas iguais ou taxa ausente (fallback seguro).
 */
export function convertPrice(
  value: number,
  from: StoreCurrency,
  to: StoreCurrency,
  rates: FxRates,
): number {
  if (!Number.isFinite(value) || value <= 0) return value;
  if (from === to) return value;
  const rate = rates[`${from}_TO_${to}`];
  if (!rate || rate <= 0) return value; // sem taxa → não converte (seguro)
  return Math.round(value * rate * 100) / 100; // 2 casas decimais
}

// Checkout Stripe da LandingLab (Story 15.3) — cálculo de valores e frete.
// Módulo puro: usado pela API (fonte da verdade do valor cobrado) e pelo
// storefront (exibição). Importável via '@blackshop/payments/checkout'.

export type ShippingMethod = 'free' | 'express';

export interface MarketShipping {
  shippingFreeEnabled: boolean;
  shippingFreeLabel: string;
  shippingFreeMinDays: number;
  shippingFreeMaxDays: number;
  shippingExpressEnabled: boolean;
  shippingExpressLabel: string;
  shippingExpressMinor: number;
  shippingExpressMinDays: number;
  shippingExpressMaxDays: number;
}

export interface ShippingOption {
  method: ShippingMethod;
  label: string;
  amountMinor: number;
  minDays: number;
  maxDays: number;
}

export function shippingOptions(market: MarketShipping): ShippingOption[] {
  const options: ShippingOption[] = [];
  if (market.shippingFreeEnabled) {
    options.push({
      method: 'free',
      label: market.shippingFreeLabel,
      amountMinor: 0,
      minDays: market.shippingFreeMinDays,
      maxDays: market.shippingFreeMaxDays,
    });
  }
  if (market.shippingExpressEnabled) {
    options.push({
      method: 'express',
      label: market.shippingExpressLabel,
      amountMinor: market.shippingExpressMinor,
      minDays: market.shippingExpressMinDays,
      maxDays: market.shippingExpressMaxDays,
    });
  }
  return options;
}

export interface CheckoutQuote {
  subtotalMinor: number;
  shipping: ShippingOption;
  totalMinor: number;
}

export class CheckoutQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutQuoteError';
  }
}

/** Valor final cobrado: subtotal do snapshot + frete escolhido do mercado. */
export function quoteCheckout(
  subtotalMinor: number,
  market: MarketShipping,
  method: ShippingMethod | null | undefined,
): CheckoutQuote {
  if (!Number.isInteger(subtotalMinor) || subtotalMinor <= 0) {
    throw new CheckoutQuoteError('Subtotal inválido.');
  }
  const options = shippingOptions(market);
  const shipping = method ? options.find((o) => o.method === method) : options[0];
  if (!shipping) throw new CheckoutQuoteError('Método de frete indisponível neste mercado.');
  return { subtotalMinor, shipping, totalMinor: subtotalMinor + shipping.amountMinor };
}

/**
 * Nome do produto para o checkout a partir do título clonado:
 * "Spicy Cubes\n   – Chemistry Club" → "Spicy Cubes" (remove a marca da origem).
 */
export function cleanProductName(title: string): string {
  const collapsed = title.replace(/\s+/g, ' ').trim();
  const [first] = collapsed.split(/\s[–—|]\s|\s-\s/);
  return (first ?? collapsed).trim() || collapsed;
}

/** IT-10001 — prefixo do primeiro país do mercado. */
export function formatOrderNumber(countryCode: string | undefined, sequence: number): string {
  const prefix = /^[A-Z]{2}$/.test(countryCode ?? '') ? countryCode! : 'LL';
  return `${prefix}-${sequence}`;
}

/** Estimativa de prazo exibida ("5–7"). */
export function deliveryRange(option: Pick<ShippingOption, 'minDays' | 'maxDays'>): string {
  return option.minDays === option.maxDays ? `${option.minDays}` : `${option.minDays}–${option.maxDays}`;
}

// ─── Header do checkout: logo (Story 15.7) ──────────────────────────────────

export const CHECKOUT_LOGO_ALIGNS = ['left', 'center', 'right'] as const;
export type CheckoutLogoAlign = (typeof CHECKOUT_LOGO_ALIGNS)[number];

/** Altura do logo em px (CHECK no banco: 16–120). */
export const CHECKOUT_LOGO_HEIGHT = { min: 16, max: 120, default: 32 } as const;

/** Prefixo do Storage onde o upload do editor grava (bucket cloned-landings). */
const STORAGE_PUBLIC_PATH = '/storage/v1/object/public/cloned-landings/';

export function isCheckoutLogoAlign(value: unknown): value is CheckoutLogoAlign {
  return typeof value === 'string' && (CHECKOUT_LOGO_ALIGNS as readonly string[]).includes(value);
}

export function isValidCheckoutLogoHeight(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CHECKOUT_LOGO_HEIGHT.min &&
    value <= CHECKOUT_LOGO_HEIGHT.max
  );
}

/**
 * URL pública do Storage do projeto (as geradas pelo upload do editor):
 * https, bucket `cloned-landings` e — quando `supabaseUrl` é conhecido — a
 * mesma origem do projeto. Qualquer outra URL é recusada.
 */
export function isProjectStorageUrl(value: unknown, supabaseUrl?: string | null): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (!url.pathname.startsWith(STORAGE_PUBLIC_PATH)) return false;
  if (supabaseUrl) {
    try {
      return url.origin === new URL(supabaseUrl).origin;
    } catch {
      return false;
    }
  }
  return true;
}

export interface CheckoutBrandView {
  /** Nome da marca (brand_to); alt do logo e fallback sem logo. */
  name: string | null;
  logoUrl: string | null;
  logoHeight: number;
  logoAlign: CheckoutLogoAlign;
}

/**
 * Marca do header do checkout a partir das colunas da landing. Valores fora
 * do contrato (URL fora do Storage, altura/alinhamento inválidos) viram o
 * padrão — o header nunca quebra por dado ruim.
 */
export function checkoutBrandView(
  input: {
    brandName?: string | null;
    logoUrl?: string | null;
    logoHeight?: number | null;
    logoAlign?: string | null;
  },
  supabaseUrl?: string | null,
): CheckoutBrandView {
  return {
    name: input.brandName?.trim() || null,
    logoUrl: isProjectStorageUrl(input.logoUrl, supabaseUrl) ? input.logoUrl : null,
    logoHeight: isValidCheckoutLogoHeight(input.logoHeight) ? input.logoHeight : CHECKOUT_LOGO_HEIGHT.default,
    logoAlign: isCheckoutLogoAlign(input.logoAlign) ? input.logoAlign : 'left',
  };
}

// ─── Assinatura (Story 15.6) ────────────────────────────────────────────────

export const SUBSCRIPTION_INTERVALS = ['day', 'week', 'month', 'year'] as const;
export type SubscriptionInterval = (typeof SUBSCRIPTION_INTERVALS)[number];

export function isSubscriptionInterval(value: unknown): value is SubscriptionInterval {
  return typeof value === 'string' && (SUBSCRIPTION_INTERVALS as readonly string[]).includes(value);
}

/**
 * Contagem válida do intervalo (inteiro 1–12). A Stripe limita a recorrência
 * a no máximo 1 ano: com intervalo `year` só vale 1 (QA 15.6 REQ-001).
 */
export function isValidIntervalCount(value: unknown, interval?: string | null): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return false;
  return value <= maxIntervalCount(interval);
}

/** Maior contagem aceita para o intervalo (year → 1; demais → 12). */
export function maxIntervalCount(interval?: string | null): number {
  return interval === 'year' ? 1 : 12;
}

/**
 * Valor recorrente cobrado em TODAS as faturas (decisão O2): preço da oferta
 * (unidade mínima da moeda — vale para moedas zero-decimal) com o desconto da
 * landing, arredondado ao inteiro mais próximo. Nunca ≤ 0.
 */
export function recurringUnitAmount(priceMinor: number, discountPercent: number | null | undefined): number {
  if (!Number.isInteger(priceMinor) || priceMinor <= 0) {
    throw new CheckoutQuoteError('Preço da oferta inválido.');
  }
  const pct = discountPercent ?? 0;
  if (!Number.isFinite(pct) || pct < 0 || pct > 99) {
    throw new CheckoutQuoteError('Desconto da assinatura inválido (0–99).');
  }
  const amount = Math.round((priceMinor * (100 - pct)) / 100);
  if (amount <= 0) throw new CheckoutQuoteError('Preço recorrente resultaria em valor zero.');
  return amount;
}

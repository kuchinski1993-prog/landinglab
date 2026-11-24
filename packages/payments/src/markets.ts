// Mercados LandingLab (Story 15.2) — presets, validação e checklist do
// checkout Stripe. Módulo puro (sem SDK Stripe): importável pelo backoffice
// via '@blackshop/payments/markets'.

/** Moedas aceitas em mercados/landings. Fonte única (substitui listas soltas). */
export const SUPPORTED_CURRENCIES = [
  'EUR',
  'USD',
  'GBP',
  'BRL',
  'JPY',
  'CHF',
  'CAD',
  'AUD',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'MXN',
  'ARS',
  'CLP',
  'COP',
  'PEN',
  'UYU',
] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export const SUPPORTED_LOCALES = ['it', 'en', 'es', 'pt', 'fr', 'de', 'nl', 'ja', 'pl', 'sv', 'da'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Textos padrão dos métodos de frete por idioma (editáveis no mercado). */
export const DEFAULT_SHIPPING_LABELS: Record<SupportedLocale, { free: string; express: string }> = {
  it: { free: 'Spedizione gratuita', express: 'Spedizione espressa' },
  en: { free: 'Free shipping', express: 'Express shipping' },
  es: { free: 'Envío gratuito', express: 'Envío exprés' },
  pt: { free: 'Envio gratuito', express: 'Envio expresso' },
  fr: { free: 'Livraison gratuite', express: 'Livraison express' },
  de: { free: 'Kostenloser Versand', express: 'Expressversand' },
  nl: { free: 'Gratis verzending', express: 'Expresverzending' },
  ja: { free: '送料無料', express: '速達配送' },
  pl: { free: 'Darmowa dostawa', express: 'Dostawa ekspresowa' },
  sv: { free: 'Fri frakt', express: 'Expressfrakt' },
  da: { free: 'Gratis fragt', express: 'Ekspresfragt' },
};

export interface MarketPreset {
  country: string;
  name: string;
  locale: SupportedLocale;
  currency: SupportedCurrency;
}

/** Atalhos do formulário: escolher o país preenche idioma e moeda. */
export const MARKET_PRESETS: readonly MarketPreset[] = [
  { country: 'IT', name: 'Itália', locale: 'it', currency: 'EUR' },
  { country: 'ES', name: 'Espanha', locale: 'es', currency: 'EUR' },
  { country: 'PT', name: 'Portugal', locale: 'pt', currency: 'EUR' },
  { country: 'FR', name: 'França', locale: 'fr', currency: 'EUR' },
  { country: 'DE', name: 'Alemanha', locale: 'de', currency: 'EUR' },
  { country: 'AT', name: 'Áustria', locale: 'de', currency: 'EUR' },
  { country: 'NL', name: 'Holanda', locale: 'nl', currency: 'EUR' },
  { country: 'BE', name: 'Bélgica', locale: 'fr', currency: 'EUR' },
  { country: 'IE', name: 'Irlanda', locale: 'en', currency: 'EUR' },
  { country: 'GB', name: 'Reino Unido', locale: 'en', currency: 'GBP' },
  { country: 'CH', name: 'Suíça', locale: 'de', currency: 'CHF' },
  { country: 'PL', name: 'Polônia', locale: 'pl', currency: 'PLN' },
  { country: 'SE', name: 'Suécia', locale: 'sv', currency: 'SEK' },
  { country: 'DK', name: 'Dinamarca', locale: 'da', currency: 'DKK' },
  { country: 'US', name: 'Estados Unidos', locale: 'en', currency: 'USD' },
  { country: 'CA', name: 'Canadá', locale: 'en', currency: 'CAD' },
  { country: 'AU', name: 'Austrália', locale: 'en', currency: 'AUD' },
  { country: 'JP', name: 'Japão', locale: 'ja', currency: 'JPY' },
  { country: 'BR', name: 'Brasil', locale: 'pt', currency: 'BRL' },
  { country: 'MX', name: 'México', locale: 'es', currency: 'MXN' },
];

export interface MarketInput {
  name: string;
  countryCodes: string[];
  locale: string;
  currency: string;
  shippingFreeEnabled: boolean;
  shippingFreeLabel: string;
  shippingFreeMinDays: number;
  shippingFreeMaxDays: number;
  shippingExpressEnabled: boolean;
  shippingExpressLabel: string;
  /** Valor do expresso em unidade mínima da moeda. */
  shippingExpressMinor: number;
  shippingExpressMinDays: number;
  shippingExpressMaxDays: number;
}

export interface MarketIssue {
  field: keyof MarketInput;
  message: string;
}

const COUNTRY_RE = /^[A-Z]{2}$/;

function validDays(min: number, max: number): boolean {
  return Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max >= min && max <= 180;
}

export function validateMarket(input: MarketInput): MarketIssue[] {
  const issues: MarketIssue[] = [];
  if (!input.name.trim()) issues.push({ field: 'name', message: 'Informe o nome do mercado.' });
  if (input.countryCodes.length === 0 || !input.countryCodes.every((c) => COUNTRY_RE.test(c))) {
    issues.push({ field: 'countryCodes', message: 'Informe ao menos um país (código de 2 letras, ex.: IT).' });
  }
  if (!isSupportedLocale(input.locale)) issues.push({ field: 'locale', message: 'Idioma não suportado.' });
  if (!isSupportedCurrency(input.currency)) issues.push({ field: 'currency', message: 'Moeda não suportada.' });
  if (!input.shippingFreeEnabled && !input.shippingExpressEnabled) {
    issues.push({ field: 'shippingFreeEnabled', message: 'Ative pelo menos um método de frete.' });
  }
  if (input.shippingFreeEnabled) {
    if (!input.shippingFreeLabel.trim()) {
      issues.push({ field: 'shippingFreeLabel', message: 'Informe o texto do frete grátis.' });
    }
    if (!validDays(input.shippingFreeMinDays, input.shippingFreeMaxDays)) {
      issues.push({ field: 'shippingFreeMinDays', message: 'Prazo do frete grátis inválido (mín. ≤ máx.).' });
    }
  }
  if (input.shippingExpressEnabled) {
    if (!input.shippingExpressLabel.trim()) {
      issues.push({ field: 'shippingExpressLabel', message: 'Informe o texto do frete expresso.' });
    }
    if (!Number.isInteger(input.shippingExpressMinor) || input.shippingExpressMinor <= 0) {
      issues.push({ field: 'shippingExpressMinor', message: 'Informe o valor do frete expresso.' });
    }
    if (!validDays(input.shippingExpressMinDays, input.shippingExpressMaxDays)) {
      issues.push({ field: 'shippingExpressMinDays', message: 'Prazo do frete expresso inválido (mín. ≤ máx.).' });
    }
  }
  return issues;
}

// ── Checklist para ativar o checkout Stripe numa landing (D19) ──────────────

export type ReadinessCode =
  | 'no_market'
  | 'market_archived'
  | 'no_active_stripe_account'
  | 'currency_mismatch'
  | 'no_priced_offers';

export interface ReadinessIssue {
  code: ReadinessCode;
  message: string;
}

export interface StripeReadinessInput {
  market: { status: string; currency: string; name: string } | null;
  landingCurrency: string;
  activeStripeAccounts: number;
  /** Ofertas com preço > 0 (landing_bundle_offers ou preço da landing). */
  pricedOffers: number;
}

export function stripeCheckoutReadiness(input: StripeReadinessInput): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  if (input.activeStripeAccounts === 0) {
    issues.push({
      code: 'no_active_stripe_account',
      message: 'Nenhuma conta Stripe ativa — cadastre em Configurações → Stripe.',
    });
  }
  if (!input.market) {
    issues.push({ code: 'no_market', message: 'Escolha o mercado da landing (idioma, moeda e frete).' });
  } else {
    if (input.market.status !== 'active') {
      issues.push({ code: 'market_archived', message: `O mercado "${input.market.name}" está arquivado.` });
    }
    if (input.market.currency !== input.landingCurrency) {
      issues.push({
        code: 'currency_mismatch',
        message: `A moeda da landing (${input.landingCurrency}) difere da do mercado (${input.market.currency}).`,
      });
    }
  }
  if (input.pricedOffers === 0) {
    issues.push({ code: 'no_priced_offers', message: 'A landing não tem ofertas com preço.' });
  }
  return issues;
}

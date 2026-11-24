import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SHIPPING_LABELS,
  MARKET_PRESETS,
  SUPPORTED_LOCALES,
  isSupportedCurrency,
  stripeCheckoutReadiness,
  validateMarket,
  type MarketInput,
} from '../markets.js';

const italy: MarketInput = {
  name: 'Itália',
  countryCodes: ['IT'],
  locale: 'it',
  currency: 'EUR',
  shippingFreeEnabled: true,
  shippingFreeLabel: 'Spedizione gratuita',
  shippingFreeMinDays: 10,
  shippingFreeMaxDays: 20,
  shippingExpressEnabled: true,
  shippingExpressLabel: 'Spedizione espressa',
  shippingExpressMinor: 990,
  shippingExpressMinDays: 5,
  shippingExpressMaxDays: 8,
};

describe('validateMarket', () => {
  it('aceita um mercado completo', () => {
    expect(validateMarket(italy)).toEqual([]);
  });

  it('aceita JPY (antes recusado no formulário da landing)', () => {
    expect(isSupportedCurrency('JPY')).toBe(true);
    expect(validateMarket({ ...italy, name: 'Japão', countryCodes: ['JP'], locale: 'ja', currency: 'JPY' })).toEqual([]);
  });

  it('aponta campos inválidos', () => {
    const fields = validateMarket({
      ...italy,
      name: ' ',
      countryCodes: ['ITA'],
      locale: 'xx',
      currency: 'XYZ',
      shippingExpressMinor: 0,
      shippingFreeMinDays: 20,
      shippingFreeMaxDays: 10,
    }).map((i) => i.field);
    expect(fields).toEqual(
      expect.arrayContaining(['name', 'countryCodes', 'locale', 'currency', 'shippingExpressMinor', 'shippingFreeMinDays']),
    );
  });

  it('exige pelo menos um método de frete', () => {
    const issues = validateMarket({ ...italy, shippingFreeEnabled: false, shippingExpressEnabled: false });
    expect(issues.map((i) => i.field)).toContain('shippingFreeEnabled');
  });

  it('método desativado não é validado', () => {
    expect(validateMarket({ ...italy, shippingExpressEnabled: false, shippingExpressMinor: 0 })).toEqual([]);
  });
});

describe('presets e textos', () => {
  it('todo preset usa idioma com textos de frete', () => {
    for (const preset of MARKET_PRESETS) {
      expect(SUPPORTED_LOCALES).toContain(preset.locale);
      expect(DEFAULT_SHIPPING_LABELS[preset.locale].free).toBeTruthy();
    }
  });
});

describe('stripeCheckoutReadiness', () => {
  const ready = {
    market: { status: 'active', currency: 'EUR', name: 'Itália' },
    landingCurrency: 'EUR',
    activeStripeAccounts: 1,
    pricedOffers: 3,
  };

  it('pronto quando tudo está configurado', () => {
    expect(stripeCheckoutReadiness(ready)).toEqual([]);
  });

  it('lista todos os bloqueios', () => {
    const codes = stripeCheckoutReadiness({
      market: null,
      landingCurrency: 'USD',
      activeStripeAccounts: 0,
      pricedOffers: 0,
    }).map((i) => i.code);
    expect(codes).toEqual(['no_active_stripe_account', 'no_market', 'no_priced_offers']);
  });

  it('detecta moeda divergente e mercado arquivado', () => {
    const codes = stripeCheckoutReadiness({
      ...ready,
      market: { status: 'archived', currency: 'EUR', name: 'Itália' },
      landingCurrency: 'USD',
    }).map((i) => i.code);
    expect(codes).toEqual(['market_archived', 'currency_mismatch']);
  });
});

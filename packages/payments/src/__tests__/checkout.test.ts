import { describe, expect, it } from 'vitest';

import { checkoutStrings } from '../checkout-i18n.js';
import {
  CheckoutQuoteError,
  checkoutBrandView,
  cleanProductName,
  isProjectStorageUrl,
  formatOrderNumber,
  quoteCheckout,
  shippingOptions,
  type MarketShipping,
} from '../checkout.js';

const italy: MarketShipping = {
  shippingFreeEnabled: true,
  shippingFreeLabel: 'Spedizione gratuita',
  shippingFreeMinDays: 7,
  shippingFreeMaxDays: 10,
  shippingExpressEnabled: true,
  shippingExpressLabel: 'Spedizione espressa',
  shippingExpressMinor: 990,
  shippingExpressMinDays: 5,
  shippingExpressMaxDays: 7,
};

describe('quoteCheckout', () => {
  it('soma o frete escolhido ao subtotal do snapshot', () => {
    expect(quoteCheckout(4990, italy, 'express').totalMinor).toBe(5980);
    expect(quoteCheckout(4990, italy, 'free').totalMinor).toBe(4990);
  });

  it('sem método escolhido usa o primeiro disponível (grátis)', () => {
    expect(quoteCheckout(4990, italy, null).shipping.method).toBe('free');
  });

  it('recusa método desativado e subtotal inválido', () => {
    expect(() => quoteCheckout(4990, { ...italy, shippingExpressEnabled: false }, 'express')).toThrow(
      CheckoutQuoteError,
    );
    expect(() => quoteCheckout(0, italy, 'free')).toThrow(CheckoutQuoteError);
    expect(() => quoteCheckout(49.9, italy, 'free')).toThrow(CheckoutQuoteError);
  });

  it('lista só os métodos ativos', () => {
    expect(shippingOptions({ ...italy, shippingFreeEnabled: false }).map((o) => o.method)).toEqual(['express']);
  });
});

describe('cleanProductName', () => {
  it('remove quebras de linha e a marca da loja de origem', () => {
    expect(cleanProductName('Spicy Cubes\n    \n    \n      – Chemistry Club')).toBe('Spicy Cubes');
    expect(cleanProductName('Serum Glow | Beauty Store')).toBe('Serum Glow');
    expect(cleanProductName('Anti-Age Cream - MyShop')).toBe('Anti-Age Cream');
    expect(cleanProductName('Anti-Age Cream')).toBe('Anti-Age Cream');
  });
});

describe('formatOrderNumber e textos', () => {
  it('prefixa com o país', () => {
    expect(formatOrderNumber('IT', 10001)).toBe('IT-10001');
    expect(formatOrderNumber(undefined, 10002)).toBe('LL-10002');
  });

  it('textos em italiano e fallback em inglês', () => {
    expect(checkoutStrings('it').payNow).toBe('Paga ora');
    expect(checkoutStrings('ja').payNow).toBe('Pay now');
  });
});

describe('header do checkout — logo (Story 15.7)', () => {
  const SUPA = 'https://abc.supabase.co';
  const LOGO = `${SUPA}/storage/v1/object/public/cloned-landings/landings/x/x/logo.png`;

  it('aceita só URL https do Storage do projeto', () => {
    expect(isProjectStorageUrl(LOGO, SUPA)).toBe(true);
    expect(isProjectStorageUrl(LOGO)).toBe(true);
    expect(isProjectStorageUrl(LOGO.replace('https:', 'http:'), SUPA)).toBe(false);
    expect(isProjectStorageUrl('https://evil.example/storage/v1/object/public/cloned-landings/a.png', SUPA)).toBe(false);
    expect(isProjectStorageUrl(`${SUPA}/storage/v1/object/public/outro-bucket/a.png`, SUPA)).toBe(false);
    expect(isProjectStorageUrl('javascript:alert(1)', SUPA)).toBe(false);
    expect(isProjectStorageUrl(42, SUPA)).toBe(false);
  });

  it('checkoutBrandView normaliza valores fora do contrato para o padrão', () => {
    expect(checkoutBrandView({ brandName: '  Aurivita ', logoUrl: LOGO, logoHeight: 48, logoAlign: 'center' }, SUPA)).toEqual({
      name: 'Aurivita',
      logoUrl: LOGO,
      logoHeight: 48,
      logoAlign: 'center',
    });
    expect(checkoutBrandView({ brandName: ' ', logoUrl: 'https://cdn/x.png', logoHeight: 500, logoAlign: 'top' }, SUPA)).toEqual({
      name: null,
      logoUrl: null,
      logoHeight: 32,
      logoAlign: 'left',
    });
  });
});

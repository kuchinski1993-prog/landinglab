import { describe, expect, it } from 'vitest';

import { currencySymbol, formatPrice, resolveCurrency } from '../format-price.js';

describe('resolveCurrency', () => {
  it('mantém as 4 moedas suportadas', () => {
    expect(resolveCurrency('GBP')).toBe('GBP');
    expect(resolveCurrency('EUR')).toBe('EUR');
    expect(resolveCurrency('USD')).toBe('USD');
    expect(resolveCurrency('BRL')).toBe('BRL');
  });
  it('normaliza case', () => {
    expect(resolveCurrency('gbp')).toBe('GBP');
    expect(resolveCurrency('eur')).toBe('EUR');
  });
  it('cai em BRL para ausente/inválida (compat pré-Bloco A)', () => {
    expect(resolveCurrency(null)).toBe('BRL');
    expect(resolveCurrency(undefined)).toBe('BRL');
    expect(resolveCurrency('')).toBe('BRL');
    expect(resolveCurrency('ABC')).toBe('BRL');
    expect(resolveCurrency('12')).toBe('BRL');
  });
});

describe('formatPrice', () => {
  it('formata BRL (default) idêntico ao Intl.NumberFormat pt-BR — zero regressão', () => {
    const expected = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(199.9);
    expect(formatPrice(199.9)).toBe(expected);
    expect(formatPrice(199.9, 'BRL')).toBe(expected);
    // Currency inválida → cai em BRL, mesmo output.
    expect(formatPrice(199.9, null)).toBe(expected);
    expect(formatPrice(199.9, 'XYZ')).toBe(expected);
  });
  it('formata GBP com locale en-GB (£)', () => {
    const out = formatPrice(119.9, 'GBP');
    expect(out).toContain('£');
    expect(out).toContain('119');
  });
  it('formata EUR com locale de-DE (€ à direita)', () => {
    const out = formatPrice(119.9, 'EUR');
    expect(out).toContain('€');
    expect(out).toContain('119');
  });
  it('formata USD com locale en-US ($)', () => {
    const out = formatPrice(119.9, 'USD');
    expect(out).toContain('$');
    expect(out).toContain('119');
  });
  it('devolve string vazia para valores não-finitos', () => {
    expect(formatPrice(NaN)).toBe('');
    expect(formatPrice(Infinity)).toBe('');
  });
  it('formata JPY com locale ja-JP (¥ sem decimais)', () => {
    const out = formatPrice(7980, 'JPY');
    // ja-JP usa full-width yen (￥ U+FFE5); outros locales usariam ¥ (U+00A5).
    // Aceita qualquer um dos dois símbolos.
    expect(out).toMatch(/[¥￥]/);
    expect(out).toContain('7,980');
    expect(out).not.toContain('.');
  });
});

describe('currencySymbol', () => {
  it('devolve o símbolo canônico das 4 moedas', () => {
    expect(currencySymbol('GBP')).toBe('£');
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('BRL')).toBe('R$');
  });
  it('normaliza input inválido para BRL (mesma regra do formatPrice)', () => {
    expect(currencySymbol(null)).toBe('R$');
    expect(currencySymbol(undefined)).toBe('R$');
    expect(currencySymbol('XYZ')).toBe('R$');
  });
  it('normaliza case-insensitive', () => {
    expect(currencySymbol('gbp')).toBe('£');
    expect(currencySymbol('eur')).toBe('€');
  });
});

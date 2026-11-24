import { describe, expect, it } from 'vitest';

import { PricingEngine } from '../pricing-engine.js';


const engine = new PricingEngine();

describe('PricingEngine', () => {
  it('passthrough: markup 0%, rate 1, returns same price', () => {
    const result = engine.apply(100, 'BRL', { exchangeRate: 1, markupPercent: 0, rounding: 'none' });
    expect(result.priceBrl).toBe(100);
  });

  it('converts USD to BRL with exchange rate', () => {
    const result = engine.apply(10, 'USD', { exchangeRate: 5.5, markupPercent: 0, rounding: 'round' });
    expect(result.priceBrl).toBe(55);
  });

  it('applies markup 30%', () => {
    const result = engine.apply(100, 'USD', { exchangeRate: 1, markupPercent: 30, rounding: 'none' });
    expect(result.priceBrl).toBe(130);
  });

  it('markup 30% + ceil rounds up', () => {
    const result = engine.apply('9.99', 'USD', { exchangeRate: 5.3, markupPercent: 30, rounding: 'ceil' });
    // 9.99 * 5.3 * 1.3 = 68.8311 → ceil → 69
    expect(result.priceBrl).toBe(69);
  });

  it('markup 30% + floor rounds down', () => {
    const result = engine.apply('9.99', 'USD', { exchangeRate: 5.3, markupPercent: 30, rounding: 'floor' });
    expect(result.priceBrl).toBe(68);
  });

  it('markup 30% + round rounds to 2 decimal places', () => {
    const result = engine.apply('9.99', 'USD', { exchangeRate: 5.3, markupPercent: 30, rounding: 'round' });
    expect(result.priceBrl).toBeCloseTo(68.83, 2);
  });

  it('priceFormatted is formatted in BRL', () => {
    const result = engine.apply(50, 'USD', { exchangeRate: 1, markupPercent: 0, rounding: 'round' });
    expect(result.priceFormatted).toContain('50');
    expect(result.priceFormatted).toMatch(/R\$|BRL/);
  });

  it('accepts string rawPrice', () => {
    const result = engine.apply('19.99', 'USD', { exchangeRate: 1, markupPercent: 0, rounding: 'none' });
    expect(result.priceBrl).toBeCloseTo(19.99, 2);
  });
});

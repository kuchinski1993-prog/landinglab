// Story 0.7 · testes de tabela da guarda de câmbio.
import { describe, expect, it } from 'vitest';

import {
  computeChangePct,
  decideRateUpdate,
  resolveBootstrapRange,
  resolveMaxVariationPercent,
  validateRate,
} from '../fx-guard.js';
import { InvalidExchangeRateError, PricingEngine } from '../pricing-engine.js';
import { planVariantPrices } from '../variant-pricing.js';

describe('validateRate', () => {
  it.each([
    [0, 'not_positive'],
    ['0', 'not_positive'],
    [-1.2, 'not_positive'],
    ['-1.2', 'not_positive'],
    [Number.NaN, 'not_a_number'],
    [Number.POSITIVE_INFINITY, 'not_a_number'],
    [Number.NEGATIVE_INFINITY, 'not_a_number'],
    ['abc', 'not_a_number'],
    ['', 'not_a_number'],
    ['1e3', 'not_a_number'],
    [null, 'not_a_number'],
    [undefined, 'not_a_number'],
    [true, 'not_a_number'],
    [{}, 'not_a_number'],
    [0.0000001, 'out_of_range'],
    [10_000, 'out_of_range'],
  ])('rejeita %p como %s', (value, reason) => {
    const r = validateRate(value);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('FX_RATE_INVALID');
      expect(r.reason).toBe(reason);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it.each([[1.18], ['1.18'], [' 6.95 '], [0.000001], ['9999.999999'], [1]])('aceita %p', (value) => {
    const r = validateRate(value);
    expect(r.ok).toBe(true);
  });

  it('normaliza para 6 casas (numeric(10,6))', () => {
    const r = validateRate('1.1765432');
    expect(r.ok && r.normalized).toBe('1.176543');
  });

  it('faixa de sanidade relativa à referência (1/1000 a 1000×)', () => {
    expect(validateRate(1.2, { reference: 1.18 }).ok).toBe(true);
    const tooBig = validateRate(1500, { reference: 1.18 });
    expect(!tooBig.ok && tooBig.reason).toBe('out_of_sanity_range');
    const tooSmall = validateRate(0.001, { reference: 1.18 });
    expect(!tooSmall.ok && tooSmall.reason).toBe('out_of_sanity_range');
  });
});

describe('computeChangePct', () => {
  it('é exata (sem erro de ponto flutuante) na borda de 5%', () => {
    expect(computeChangePct('1.2', '1.26')?.toString()).toBe('5');
    expect(computeChangePct('1.2', '1.14')?.toString()).toBe('-5');
  });
  it('null com base inválida', () => {
    expect(computeChangePct('0', '1.2')).toBeNull();
  });
});

describe('resolveMaxVariationPercent', () => {
  it('default 5 e respeita a configuração da loja', () => {
    expect(resolveMaxVariationPercent({})).toBe(5);
    expect(resolveMaxVariationPercent(null)).toBe(5);
    expect(resolveMaxVariationPercent({ fxMaxVariationPercent: 8 })).toBe(8);
    expect(resolveMaxVariationPercent({ fxMaxVariationPercent: '3.5' })).toBe(3.5);
    expect(resolveMaxVariationPercent({ fxMaxVariationPercent: 0 })).toBe(5);
    expect(resolveMaxVariationPercent({ fxMaxVariationPercent: 'abc' })).toBe(5);
  });
});

describe('decideRateUpdate', () => {
  const base = { hasAppliedHistory: true, locked: false, maxVariationPercent: 5 };

  it.each([
    ['1.2558', 'apply'], // +4,65%
    ['1.26', 'apply'], // +5,00% exato (borda: > e não >=)
    ['1.260120', 'pending_approval'], // +5,01%
    ['1.14', 'apply'], // -5,00%
    ['1.139880', 'pending_approval'], // -5,01% (módulo)
    ['1.68', 'pending_approval'], // salto de 40%
  ])('taxa vigente 1.2 → %s = %s', (proposed, kind) => {
    const d = decideRateUpdate({ ...base, currentRate: '1.200000', proposedRate: proposed });
    expect(d.kind).toBe(kind);
  });

  it('4,9% aplica, 5,0% aplica, 5,01% fica pendente (base 1)', () => {
    const opts = { ...base, currentRate: '1.000000' };
    expect(decideRateUpdate({ ...opts, proposedRate: '1.049' }).kind).toBe('apply');
    expect(decideRateUpdate({ ...opts, proposedRate: '1.05' }).kind).toBe('apply');
    expect(decideRateUpdate({ ...opts, proposedRate: '1.0501' }).kind).toBe('pending_approval');
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['abc'], [50_000]])(
    'taxa inválida %p → invalid sem alterar',
    (proposed) => {
      const d = decideRateUpdate({ ...base, currentRate: '1.18', proposedRate: proposed });
      expect(d.kind).toBe('invalid');
    },
  );

  it('semente 1 sem histórico → bootstrap mesmo com +18%', () => {
    const d = decideRateUpdate({ ...base, hasAppliedHistory: false, currentRate: '1.000000', proposedRate: 1.18 });
    expect(d).toMatchObject({ kind: 'apply', origin: 'bootstrap', newRate: '1.18' });
  });

  it.each([
    [0.00001, 'pending_approval'],
    [0.19, 'pending_approval'],
    [0.2, 'apply'],
    [5, 'apply'],
    [7, 'pending_approval'],
  ])('F4: bootstrap só aplica sozinho entre 0,2 e 5 (%p → %s)', (proposed, kind) => {
    const d = decideRateUpdate({ ...base, hasAppliedHistory: false, currentRate: '1', proposedRate: proposed });
    expect(d.kind).toBe(kind);
    if (d.kind === 'pending_approval') expect(d.cause).toBe('bootstrap_out_of_range');
  });

  it('F4: faixa do bootstrap configurável', () => {
    const d = decideRateUpdate({
      ...base,
      hasAppliedHistory: false,
      currentRate: '1',
      proposedRate: 7,
      bootstrapRange: resolveBootstrapRange({ fxBootstrapMaxRate: 10 }),
    });
    expect(d).toMatchObject({ kind: 'apply', origin: 'bootstrap' });
    expect(resolveBootstrapRange({})).toEqual({ min: 0.2, max: 5 });
    expect(resolveBootstrapRange({ fxBootstrapMinRate: 9, fxBootstrapMaxRate: 2 })).toEqual({ min: 0.2, max: 5 });
  });

  it('semente 1 sem histórico mas taxa inválida → invalid', () => {
    const d = decideRateUpdate({ ...base, hasAppliedHistory: false, currentRate: '1', proposedRate: 0 });
    expect(d.kind).toBe('invalid');
  });

  it('taxa 1 COM histórico aplicado → guarda normal', () => {
    const d = decideRateUpdate({ ...base, hasAppliedHistory: true, currentRate: '1', proposedRate: 1.18 });
    expect(d.kind).toBe('pending_approval');
  });

  it('sem histórico e taxa ≠ 1 → a vigente vira base', () => {
    expect(
      decideRateUpdate({ ...base, hasAppliedHistory: false, currentRate: '1.18', proposedRate: 1.65 }).kind,
    ).toBe('pending_approval');
    expect(
      decideRateUpdate({ ...base, hasAppliedHistory: false, currentRate: '1.18', proposedRate: 1.19 }),
    ).toMatchObject({ kind: 'apply', origin: 'frankfurter' });
  });

  it('regra travada → skipped_locked', () => {
    const d = decideRateUpdate({ ...base, locked: true, currentRate: '1.18', proposedRate: 1.5 });
    expect(d.kind).toBe('skipped_locked');
  });

  it('taxa igual à vigente → unchanged', () => {
    expect(decideRateUpdate({ ...base, currentRate: '1.180000', proposedRate: 1.18 }).kind).toBe('unchanged');
  });

  it('taxa vigente 0 (gravada no passado) → pending_approval com causa baseline_invalid', () => {
    const d = decideRateUpdate({ ...base, currentRate: '0', proposedRate: 1.18 });
    expect(d).toMatchObject({ kind: 'pending_approval', cause: 'baseline_invalid' });
  });
});

describe('PricingEngine — última barreira (taxa 0 nunca vira 0.00)', () => {
  const engine = new PricingEngine();
  it.each([[0], ['0'], [-1], [Number.NaN], ['abc']])('lança para taxa %p', (rate) => {
    expect(() => engine.apply(30, 'GBP', { exchangeRate: rate as number, markupPercent: 2, rounding: 'ceil' })).toThrow(
      InvalidExchangeRateError,
    );
  });
});

describe('planVariantPrices', () => {
  const rule = { exchangeRate: '1.2', markupPercent: '2', rounding: 'ceil' };
  it('preço por variante (£30/£50/£70 → 3 valores distintos)', () => {
    const plan = planVariantPrices({
      variants: [
        { id: 'v1', mirrorVariantId: 'm1', price: '30.00' },
        { id: 'v2', mirrorVariantId: 'm2', price: '50.00' },
        { id: 'v3', mirrorVariantId: 'm3', price: '70.00' },
      ],
      productBasePrice: '30.00',
      sourceCurrency: 'GBP',
      targetCurrency: 'EUR',
      rule,
    });
    // 30×1,2×1,02=36,72→37 · 50→61,2→62 · 70→85,68→86
    expect(plan.items.map((i) => i.amount)).toEqual(['37.00', '62.00', '86.00']);
    expect(plan.fallbacks).toEqual([]);
    expect(plan.failures).toEqual([]);
  });

  it('variante sem preço usa o do produto (fallback) e sem preço nenhum falha', () => {
    const plan = planVariantPrices({
      variants: [
        { id: 'v1', mirrorVariantId: 'm1', price: null },
        { id: 'v2', mirrorVariantId: 'm2', price: '0' },
      ],
      productBasePrice: '30.00',
      sourceCurrency: 'GBP',
      targetCurrency: 'EUR',
      rule,
    });
    expect(plan.fallbacks).toEqual(['v1', 'v2']);
    expect(plan.items).toHaveLength(2);

    const none = planVariantPrices({
      variants: [{ id: 'v1', mirrorVariantId: 'm1', price: null }],
      productBasePrice: null,
      sourceCurrency: 'GBP',
      targetCurrency: 'EUR',
      rule,
    });
    expect(none.items).toEqual([]);
    expect(none.failures[0]?.code).toBe('NO_BASE_PRICE');
  });

  it('valor convertido <= 0 nunca é enviado (PRICE_NOT_POSITIVE)', () => {
    const plan = planVariantPrices({
      variants: [{ id: 'v1', mirrorVariantId: 'm1', price: '0.001' }],
      productBasePrice: null,
      sourceCurrency: 'GBP',
      targetCurrency: 'EUR',
      rule: { exchangeRate: '0.5', markupPercent: '0', rounding: 'floor' },
    });
    expect(plan.items).toEqual([]);
    expect(plan.failures[0]?.code).toBe('PRICE_NOT_POSITIVE');
  });

  it('taxa inválida → PRICING_FAILED (nada enviado)', () => {
    const plan = planVariantPrices({
      variants: [{ id: 'v1', mirrorVariantId: 'm1', price: '30' }],
      productBasePrice: '30',
      sourceCurrency: 'GBP',
      targetCurrency: 'EUR',
      rule: { exchangeRate: '0', markupPercent: '0', rounding: 'ceil' },
    });
    expect(plan.items).toEqual([]);
    expect(plan.failures[0]?.code).toBe('PRICING_FAILED');
  });
});

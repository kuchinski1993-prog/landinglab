// Story 18.3b · T2 — plano puro de sincronização de variantes (R1–R4, recusas, ordem de saída).
import { describe, expect, it } from 'vitest';

import type { ShopifyVariantInput } from '../adapter.interface.js';
import { ShopifyVariantPlanError, normalizeOption, ownedSkuStem, payloadKnowsMirror, planVariantSync } from '../variant-sync-plan.js';

// Remotas da família de SKU do produto no BlackShop (`BS-abc123-NNN`), como o publish.processor cria.
const r = (id: string, ...options: string[]) => ({ id, options, sku: `BS-abc123-${id.padStart(3, '0')}` });
const p = (options: string[], mirrorVariantId?: string | null): ShopifyVariantInput => ({
  title: options.join(' / '),
  price: '10.00',
  sku: `BS-abc123-${options.join('').length + 1}`,
  optionValues: options,
  ...(mirrorVariantId !== undefined && { mirrorVariantId }),
});

function refusal(fn: () => unknown): ShopifyVariantPlanError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ShopifyVariantPlanError) return err;
    throw err;
  }
  throw new Error('esperava ShopifyVariantPlanError');
}

describe('planVariantSync · regras', () => {
  it('R1 · vínculo com ou sem gid casa, independente da posição e das opções', () => {
    const plan = planVariantSync([r('1', 'A'), r('2', 'B'), r('3', 'C')], [p(['C'], 'gid://shopify/ProductVariant/3'), p(['X'], '1')]);
    expect(plan.ordered).toStrictEqual([
      { index: 0, remoteId: '3' },
      { index: 1, remoteId: '1' },
    ]);
    expect(plan.update).toStrictEqual([
      { index: 0, remoteId: '3' },
      { index: 1, remoteId: '1' },
    ]);
    expect(plan.create).toStrictEqual([]);
    expect(plan.remove).toStrictEqual(['2']);
  });

  it('R2 · sem vínculo ou vínculo velho → opções normalizadas (mesma normalização do worker)', () => {
    expect(normalizeOption(' Off_White - G ')).toBe('offwhiteg');
    const plan = planVariantSync([r('1', 'bege', ' m '), r('2', 'Preto', 'G')], [p(['Bege', 'M'], null), p(['preto', 'g'], '999')]);
    expect(plan.ordered.map((o) => o.remoteId)).toStrictEqual(['1', '2']);
    expect(plan.remove).toStrictEqual([]);
  });

  it('R2 não reaproveita remota já casada por vínculo', () => {
    const plan = planVariantSync([r('1', 'A'), r('2', 'B')], [p(['B'], '1'), p(['B'], null)]);
    expect(plan.ordered).toStrictEqual([
      { index: 0, remoteId: '1' },
      { index: 1, remoteId: '2' },
    ]);
  });

  it('R3 · 1 variante dos dois lados casa mesmo com opções divergentes', () => {
    const plan = planVariantSync([r('1', 'Default Title')], [{ title: 'Default', price: '1.00', mirrorVariantId: null }]);
    expect(plan.ordered).toStrictEqual([{ index: 0, remoteId: '1' }]);
  });

  it('R4 · resto do payload é criado e resto do remoto é órfão; saída na ordem do payload', () => {
    const plan = planVariantSync([r('1', 'A'), r('2', 'B'), r('3', 'C')], [p(['A'], '1'), p(['N'], null), p(['C'], '3')]);
    expect(plan.create).toStrictEqual([1]);
    expect(plan.remove).toStrictEqual(['2']);
    expect(plan.ordered).toStrictEqual([
      { index: 0, remoteId: '1' },
      { index: 1, remoteId: null },
      { index: 2, remoteId: '3' },
    ]);
  });

  it('remoto vazio: tudo criado (shell sem variantes)', () => {
    const plan = planVariantSync([], [p(['A'], null), p(['B'], null)]);
    expect(plan.create).toStrictEqual([0, 1]);
    expect(plan.update).toStrictEqual([]);
  });
});

describe('planVariantSync · recusas (nenhuma escrita)', () => {
  it('(a) dois com o mesmo vínculo (gid e numérico contam como o mesmo)', () => {
    const err = refusal(() => planVariantSync([r('1', 'A'), r('2', 'B')], [p(['A'], 'gid://shopify/ProductVariant/1'), p(['B'], '1')]));
    expect(err.code).toBe('shopify.variant_plan_duplicate_mirror');
    expect(err.message).toContain('variantes 1 e 2');
  });

  it('(b) remoto truncado em 100 (hasNextPage)', () => {
    const err = refusal(() => planVariantSync([r('1', 'A')], [p(['A'], '1')], { remoteHasNextPage: true }));
    expect(err.code).toBe('shopify.variant_plan_remote_truncated');
  });

  it('(c) nenhuma casa num produto de várias variantes', () => {
    expect(refusal(() => planVariantSync([r('1', 'A'), r('2', 'B')], [p(['X'], null)])).code).toBe('shopify.variant_plan_no_match');
    expect(refusal(() => planVariantSync([r('1', 'A')], [p(['X'], null), p(['Y'], '77')])).code).toBe('shopify.variant_plan_no_match');
  });

  it('ambiguidade por opções (duas disputam a mesma remota) nunca vira chute', () => {
    const err = refusal(() => planVariantSync([r('1', 'A'), r('2', 'B')], [p(['A'], null), p(['a'], null)]));
    expect(err.code).toBe('shopify.variant_plan_ambiguous');
    expect(refusal(() => planVariantSync([r('1', 'A'), r('2', 'a')], [p(['A'], null)])).code).toBe('shopify.variant_plan_ambiguous');
  });

  it('mensagens em português, com o caso e o que fazer', () => {
    const err = refusal(() => planVariantSync([r('1', 'A'), r('2', 'B')], [p(['X'], null)]));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ShopifyVariantPlanError');
    expect(err.message).toMatch(/^Plano de variantes recusado \(shopify\.variant_plan_no_match\): .*Confira os vínculos.*Nada foi alterado na Shopify\.$/);
  });
});

describe('QA 18.3b · só remove órfã do BlackShop (família de SKU do payload)', () => {
  it('radical comum dos SKUs do payload; SKUs de famílias diferentes ou sem serial → null', () => {
    expect(ownedSkuStem([{ title: 'a', price: '1', sku: 'BS-abc123-001' }, { title: 'b', price: '1', sku: 'BS-abc123-002' }])).toBe('BS-abc123');
    expect(ownedSkuStem([{ title: 'a', price: '1', sku: 'BS-abc123-001' }, { title: 'b', price: '1', sku: 'BS-ffffff-002' }])).toBeNull();
    expect(ownedSkuStem([{ title: 'a', price: '1', sku: 'CAMISA' }])).toBeNull();
    expect(ownedSkuStem([{ title: 'a', price: '1' }])).toBeNull();
  });

  it('órfã com SKU vazio, de outro padrão ou de outro produto → recusa; com SKU da família → remove', () => {
    const payload = [p(['A'], '1')];
    for (const sku of [null, '', 'MANUAL-9', 'BS-ffffff-002']) {
      const err = refusal(() => planVariantSync([r('1', 'A'), { id: '2', options: ['B'], sku }], payload));
      expect(err.code).toBe('shopify.variant_plan_foreign_orphan');
      expect(err.message).toContain('2');
    }
    expect(planVariantSync([r('1', 'A'), r('2', 'B')], payload).remove).toStrictEqual(['2']);
  });

  it('payload sem família de SKU → nenhuma órfã é apagável (recusa)', () => {
    const payload = [{ ...p(['A'], '1'), sku: 'CAMISA' }];
    expect(refusal(() => planVariantSync([r('1', 'A'), r('2', 'B')], payload)).code).toBe('shopify.variant_plan_foreign_orphan');
  });

  it('refuseForeignOrphans=false (removeOrphans desligado) não recusa; órfãs só listadas', () => {
    const plan = planVariantSync([r('1', 'A'), { id: '2', options: ['B'], sku: '' }], [p(['A'], '1')], { refuseForeignOrphans: false });
    expect(plan.remove).toStrictEqual(['2']);
  });
});

describe('payloadKnowsMirror', () => {
  it('campo ausente em todas = chamador antigo; presente (mesmo null) em uma = conhece', () => {
    expect(payloadKnowsMirror([p(['A']), p(['B'])])).toBe(false);
    expect(payloadKnowsMirror([p(['A']), p(['B'], null)])).toBe(true);
    expect(payloadKnowsMirror([])).toBe(false);
  });
});

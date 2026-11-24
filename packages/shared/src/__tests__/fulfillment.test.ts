// Story 23.3 · AC2 — tabela de verdade da regra de disponibilidade (política × estoque × qty ×
// sellWithoutStock × prazo na variante/produto/ausente).
import { describe, expect, it } from 'vitest';

import {
  buildOrderLineSnapshot,
  isLeadTimeResolvable,
  resolveLeadTimeDays,
  resolveLineFulfillment,
  resolveVariantAvailability,
  type FulfillmentPolicy,
  type FulfillmentResult,
} from '../fulfillment.js';

type Lead = 'variant' | 'product' | 'none';
const STOCKS = [null, 0, 3] as const;
const QTYS = [1, 3, 5] as const;
const SWS = [false, true] as const;
const LEADS: Lead[] = ['variant', 'product', 'none'];

function leadInput(lead: Lead): { variantLeadTimeDays: number | null; productLeadTimeDays: number | null } {
  if (lead === 'variant') return { variantLeadTimeDays: 10, productLeadTimeDays: 30 };
  if (lead === 'product') return { variantLeadTimeDays: null, productLeadTimeDays: 30 };
  return { variantLeadTimeDays: null, productLeadTimeDays: null };
}
const expectedLead = (lead: Lead): number | null => (lead === 'variant' ? 10 : lead === 'product' ? 30 : null);

/** Expectativa escrita à mão, independente da implementação. */
function expected(policy: FulfillmentPolicy, stock: number | null, qty: number, sws: boolean, lead: Lead): FulfillmentResult {
  const s = stock ?? 0;
  const mto: FulfillmentResult = { availability: 'made_to_order', remaining: null, leadTimeDays: expectedLead(lead) };
  if (policy === 'made_to_order_only') return mto;
  if (policy === 'stock_then_made_to_order') return s >= qty ? { availability: 'in_stock', remaining: s, leadTimeDays: null } : mto;
  if (sws) return { availability: 'in_stock', remaining: null, leadTimeDays: null };
  return s >= qty ? { availability: 'in_stock', remaining: s, leadTimeDays: null } : { availability: 'sold_out', remaining: null, leadTimeDays: null };
}

const CASES: Array<[FulfillmentPolicy, number | null, number, boolean, Lead]> = [];
for (const policy of ['stock_only', 'stock_then_made_to_order', 'made_to_order_only'] as const) {
  for (const stock of STOCKS) for (const qty of QTYS) for (const sws of SWS) for (const lead of LEADS) CASES.push([policy, stock, qty, sws, lead]);
}

describe('resolveLineFulfillment — tabela de verdade', () => {
  it('tem pelo menos 30 casos', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(CASES)('%s · stock=%s · qty=%s · sellWithoutStock=%s · prazo=%s', (policy, stock, qty, sws, lead) => {
    expect(resolveLineFulfillment({ policy, stock, sellWithoutStock: sws, ...leadInput(lead) }, qty)).toEqual(expected(policy, stock, qty, sws, lead));
  });
});

describe('casos nomeados da story', () => {
  it('stock_only + sellWithoutStock = in_stock sem "restam"', () => {
    expect(resolveVariantAvailability({ policy: 'stock_only', sellWithoutStock: true, stock: 0 })).toEqual({ availability: 'in_stock', remaining: null, leadTimeDays: null });
  });
  it('stock_only sem estoque = sold_out; estoque null conta como 0', () => {
    expect(resolveVariantAvailability({ policy: 'stock_only', sellWithoutStock: false, stock: null }).availability).toBe('sold_out');
  });
  it('made_to_order_only ignora estoque', () => {
    expect(resolveLineFulfillment({ policy: 'made_to_order_only', sellWithoutStock: false, stock: 99, productLeadTimeDays: 20 }, 1)).toEqual({
      availability: 'made_to_order',
      remaining: null,
      leadTimeDays: 20,
    });
  });
  it('híbrida com qty > estoque = a linha inteira sob encomenda (decisão 74)', () => {
    expect(resolveLineFulfillment({ policy: 'stock_then_made_to_order', sellWithoutStock: false, stock: 3, productLeadTimeDays: 20 }, 4)).toEqual({
      availability: 'made_to_order',
      remaining: null,
      leadTimeDays: 20,
    });
  });
  it('política desconhecida/ausente = stock_only (padrão)', () => {
    expect(resolveVariantAvailability({ policy: 'xpto', sellWithoutStock: false, stock: 2 })).toEqual({ availability: 'in_stock', remaining: 2, leadTimeDays: null });
    expect(resolveVariantAvailability({ policy: null, sellWithoutStock: false, stock: 0 }).availability).toBe('sold_out');
  });
  it('qty inválido conta como 1; estoque negativo/fracionado normalizado', () => {
    expect(resolveLineFulfillment({ policy: 'stock_only', sellWithoutStock: false, stock: 1 }, 0).availability).toBe('in_stock');
    expect(resolveLineFulfillment({ policy: 'stock_only', sellWithoutStock: false, stock: -2 }, 1).availability).toBe('sold_out');
    expect(resolveLineFulfillment({ policy: 'stock_only', sellWithoutStock: false, stock: 2.7 }, 1)).toEqual({ availability: 'in_stock', remaining: 2, leadTimeDays: null });
  });
});

describe('prazo', () => {
  it('variante vence produto; valores fora de 1–365 ou não inteiros = ausentes', () => {
    expect(resolveLeadTimeDays(5, 20)).toBe(5);
    expect(resolveLeadTimeDays(null, 20)).toBe(20);
    expect(resolveLeadTimeDays(0, 20)).toBe(20);
    expect(resolveLeadTimeDays(366, null)).toBeNull();
    expect(resolveLeadTimeDays(2.5, undefined)).toBeNull();
  });

  it('isLeadTimeResolvable: stock_only sempre; senão produto ou todas as variantes', () => {
    expect(isLeadTimeResolvable('stock_only', null, [null])).toBe(true);
    expect(isLeadTimeResolvable('made_to_order_only', 15, [null])).toBe(true);
    expect(isLeadTimeResolvable('made_to_order_only', null, [10, 12])).toBe(true);
    expect(isLeadTimeResolvable('made_to_order_only', null, [10, null])).toBe(false);
    expect(isLeadTimeResolvable('stock_then_made_to_order', null, [])).toBe(false);
  });
});

describe('buildOrderLineSnapshot — única fonte do formato do pedido', () => {
  it('in_stock → { mode, leadTimeDays: null }; made_to_order → prazo; sold_out → null', () => {
    expect(buildOrderLineSnapshot({ availability: 'in_stock', remaining: 3, leadTimeDays: null })).toEqual({ mode: 'in_stock', leadTimeDays: null });
    expect(buildOrderLineSnapshot({ availability: 'made_to_order', remaining: null, leadTimeDays: 20 })).toEqual({ mode: 'made_to_order', leadTimeDays: 20 });
    expect(buildOrderLineSnapshot({ availability: 'sold_out', remaining: null, leadTimeDays: null })).toBeNull();
  });
  it('as chaves do snapshot são exatamente mode e leadTimeDays', () => {
    expect(Object.keys(buildOrderLineSnapshot({ availability: 'in_stock', remaining: 1, leadTimeDays: null })!)).toEqual(['mode', 'leadTimeDays']);
  });
});

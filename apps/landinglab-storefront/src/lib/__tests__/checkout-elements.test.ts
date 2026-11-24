// Regressões de QA 15.3 no cliente do checkout (Stripe Elements):
//   UX-008 — Express Checkout abre com o frete atual da sessão selecionado;
//   MNT-004 — valores para Elements na unidade da Stripe (COP com 2 casas);
//   REL-001 — trocas de frete serializadas no cliente (uma por vez).
import { describe, expect, it } from 'vitest';

import { createShippingSwitch, elementsAmount, expressShippingRates } from '../checkout-elements';

const options = [
  { method: 'free' as const, label: 'Gratuita', amountMinor: 0, minDays: 7, maxDays: 10 },
  { method: 'express' as const, label: 'Espressa', amountMinor: 990, minDays: 5, maxDays: 7 },
];

describe('expressShippingRates (UX-008)', () => {
  it('método atual da sessão vem primeiro (a folha da carteira seleciona a 1ª tarifa)', () => {
    expect(expressShippingRates(options, 'express', 'EUR').map((r) => r.id)).toEqual(['express', 'free']);
    expect(expressShippingRates(options, 'free', 'EUR').map((r) => r.id)).toEqual(['free', 'express']);
    expect(expressShippingRates(options, 'express', 'EUR')[0]).toMatchObject({
      displayName: 'Espressa',
      amount: 990,
      deliveryEstimate: { minimum: { unit: 'business_day', value: 5 }, maximum: { unit: 'business_day', value: 7 } },
    });
  });

  it('valores na unidade da Stripe (MNT-004)', () => {
    const cop = [{ ...options[1]!, amountMinor: 15000 }];
    expect(expressShippingRates(cop, 'express', 'COP')[0]!.amount).toBe(1500000);
    expect(elementsAmount(120000, 'COP')).toBe(12000000);
    expect(elementsAmount(2990, 'EUR')).toBe(2990);
    expect(elementsAmount(5000, 'JPY')).toBe(5000);
  });
});

describe('createShippingSwitch (REL-001)', () => {
  it('ignora cliques enquanto uma troca está pendente e libera ao terminar', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending: boolean[] = [];
    const sw = createShippingSwitch(
      async (method: string) => {
        calls.push(method);
        if (method === 'express') await gate;
        return true;
      },
      (p) => pending.push(p),
    );
    const first = sw('express');
    expect(await sw('free')).toBe(false); // clique durante a troca: ignorado
    release();
    expect(await first).toBe(true);
    expect(await sw('free')).toBe(true);
    expect(calls).toEqual(['express', 'free']);
    expect(pending).toEqual([true, false, true, false]);
  });
});

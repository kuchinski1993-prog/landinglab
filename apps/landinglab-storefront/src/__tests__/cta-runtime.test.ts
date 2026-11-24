// E2E Stripe B-4 — CTA da landing Stripe: preço recorrente com o checkbox de
// assinatura marcado e rótulo no idioma do mercado.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { recurringUnitAmount } from '@blackshop/payments';
import { describe, expect, it } from 'vitest';

import { RELABEL_CTA_RUNTIME_JS, SUBSCRIPTION_CENTS_RUNTIME_JS } from '../lib/cta-runtime';

type Labels = { addToCart: string; buyNow: string } | null;
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const relabel = new Function(`return ${RELABEL_CTA_RUNTIME_JS};`)() as (text: string, labels: Labels) => string;
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const subscriptionCents = new Function(`return ${SUBSCRIPTION_CENTS_RUNTIME_JS};`)() as (cents: number, pct: number) => number;

const IT = { addToCart: 'Aggiungi al carrello', buyNow: 'Acquista ora' };

describe('rótulo do CTA (runtime)', () => {
  it('troca só a frase em inglês do tema, preservando o resto', () => {
    expect(relabel('Add to cart', IT)).toBe('Aggiungi al carrello');
    expect(relabel('ADD TO CART', IT)).toBe('AGGIUNGI AL CARRELLO');
    expect(relabel('Add to Bag', IT)).toBe('Aggiungi al carrello');
    expect(relabel('Buy it now', IT)).toBe('Acquista ora');
  });

  it('texto já traduzido / sem rótulos fica intacto (idempotente)', () => {
    expect(relabel('Aggiungi al carrello', IT)).toBe('Aggiungi al carrello');
    expect(relabel('Jetzt kaufen', IT)).toBe('Jetzt kaufen');
    expect(relabel('Add to cart', null)).toBe('Add to cart');
  });
});

describe('preço recorrente no CTA (runtime)', () => {
  it('mesmo arredondamento do servidor (recurringUnitAmount)', () => {
    for (const [cents, pct] of [
      [1900, 15],
      [2900, 15],
      [3900, 15],
      [1999, 7],
      [4999, 33],
    ] as const) {
      expect(subscriptionCents(cents, pct)).toBe(recurringUnitAmount(cents, pct));
    }
    expect(subscriptionCents(1900, 15)).toBe(1615); // €16.15 do E2E
  });

  it('sem desconto válido → preço da oferta', () => {
    expect(subscriptionCents(1900, 0)).toBe(1900);
    expect(subscriptionCents(1900, 100)).toBe(1900);
    expect(subscriptionCents(1900, Number.NaN)).toBe(1900);
  });
});

describe('Engine V2 (código-fonte da rota da landing)', () => {
  const src = readFileSync(resolve(__dirname, '../app/landing/[host]/[[...slug]]/route.ts'), 'utf-8');

  it('preço do CTA passa pelo desconto da assinatura e rótulo pelo relabel — só em checkout Stripe', () => {
    expect(src).toContain('var major = subscriptionCents(offer.priceCents, subscriptionPct()) / MINOR_UNIT_DIVISOR;');
    expect(src).toContain("if(window.__LL_CHECKOUT_PROVIDER__ !== 'stripe' || !wantsSubscription()) return 0;");
    expect(src).toContain("if(window.__LL_CHECKOUT_PROVIDER__ !== 'stripe') return null;");
    expect(src).toContain('if(labels) base = relabelCta(base, labels);');
  });

  it('checkbox do widget re-sincroniza o CTA sem MutationObserver novo; escrita só quando muda', () => {
    expect(src).toContain("if(t && t.matches && t.matches('[data-landinglab-subs-check]')) syncCtaPrice();");
    expect(src).toContain('if(el.textContent !== next) el.textContent = next;');
    expect(src.match(/new MutationObserver/g)?.length ?? 0).toBe(1);
  });
});

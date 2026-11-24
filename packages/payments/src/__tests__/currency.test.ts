// Regressão QA 15.3 MNT-004: casas decimais da Stripe ≠ Intl (COP) e
// QA 15.6 REQ-001: recorrência anual com contagem > 1.
import { describe, expect, it, vi } from 'vitest';

import {
  appCurrencyDigits,
  fromStripeAmount,
  stripeCurrencyDigits,
  toStripeAmount,
} from '../currency.js';
import {
  createIncompleteSubscription,
  createPaymentIntent,
  createRefund,
  ensureOfferPrice,
  isValidIntervalCount,
  readInvoice,
  retrieveSettlement,
  updatePaymentIntent,
  type OfferPriceStore,
  type StripeClient,
} from '../index.js';

describe('tabela de decimais da Stripe (MNT-004)', () => {
  it('COP: app grava sem casas (Intl), Stripe espera duas', () => {
    expect(appCurrencyDigits('COP')).toBe(0);
    expect(stripeCurrencyDigits('COP')).toBe(2);
    expect(toStripeAmount(120000, 'COP')).toBe(12000000);
    expect(fromStripeAmount(12000000, 'cop')).toBe(120000);
  });

  it('zero-decimal oficiais e moedas de 2 casas passam inalteradas', () => {
    for (const c of ['JPY', 'CLP', 'KRW', 'PYG', 'XOF']) {
      expect(stripeCurrencyDigits(c)).toBe(0);
      expect(toStripeAmount(7980, c)).toBe(7980);
    }
    for (const c of ['EUR', 'USD', 'BRL', 'MXN', 'ARS', 'UYU', 'PEN', 'TWD']) {
      expect(toStripeAmount(7980, c)).toBe(7980);
      expect(fromStripeAmount(7980, c)).toBe(7980);
    }
  });

  it('casos especiais ISK/UGX/HUF: duas casas terminando em 00', () => {
    expect(toStripeAmount(5, 'ISK')).toBe(500);
    expect(toStripeAmount(5, 'UGX')).toBe(500);
    expect(toStripeAmount(1045, 'HUF')).toBe(104500);
  });

  it('três casas (BHD/KWD) coincidem com o ISO', () => {
    expect(stripeCurrencyDigits('KWD')).toBe(3);
    expect(toStripeAmount(1500, 'BHD')).toBe(1500);
  });
});

describe('fronteira com a Stripe usa a tabela da Stripe (MNT-004)', () => {
  it('createPaymentIntent/updatePaymentIntent em COP enviam 100x e devolvem na unidade da app', async () => {
    const create = vi.fn(async (p: { amount: number }) => ({ id: 'pi_1', client_secret: 's', amount: p.amount, status: 'x', currency: 'cop' }));
    const update = vi.fn(async (_id: string, p: { amount: number }) => ({ id: 'pi_1', client_secret: 's', amount: p.amount, status: 'x', currency: 'cop' }));
    const client = { paymentIntents: { create, update } } as unknown as StripeClient;
    const created = await createPaymentIntent(client, {
      amountMinor: 120000,
      currency: 'COP',
      description: 'x',
      metadata: {},
      idempotencyKey: 'k',
    });
    expect(create.mock.calls[0]![0]).toMatchObject({ amount: 12000000, currency: 'cop' });
    expect(created.amountMinor).toBe(120000);
    const updated = await updatePaymentIntent(client, 'pi_1', { amountMinor: 130000, currency: 'COP' });
    expect(update.mock.calls[0]![1]).toMatchObject({ amount: 13000000 });
    expect(updated.amountMinor).toBe(130000);
  });

  it('createRefund converte o valor parcial; settlement e fatura voltam na unidade da app', async () => {
    const refunds = { create: vi.fn(async (p: { amount?: number }) => ({ id: 're_1', amount: p.amount ?? 0, currency: 'cop', status: 'succeeded' })) };
    const r = await createRefund({ refunds } as unknown as StripeClient, {
      paymentIntentId: 'pi_1',
      amountMinor: 1000,
      currency: 'COP',
      idempotencyKey: 'k',
    });
    expect(refunds.create.mock.calls[0]![0]).toMatchObject({ amount: 100000 });
    expect(r.amountMinor).toBe(1000);

    const pi = { latest_charge: { balance_transaction: { amount: 12000000, currency: 'cop' } } };
    const settlement = await retrieveSettlement({ paymentIntents: { retrieve: async () => pi } } as unknown as StripeClient, 'pi_1');
    expect(settlement).toEqual({ amountMinor: 120000, currency: 'COP' });

    const inv = readInvoice({ id: 'in_1', amount_paid: 12000000, amount_due: 12000000, currency: 'cop' });
    expect(inv.amountPaidMinor).toBe(120000);
    expect(inv.amountDueMinor).toBe(120000);
  });

  it('Price recorrente e frete da 1ª fatura em COP', async () => {
    const prices = { create: vi.fn(async () => ({ id: 'price_1' })) };
    const products = { create: vi.fn(async () => ({ id: 'prod_1' })) };
    const store: OfferPriceStore = { find: async () => null, findProduct: async () => null, save: async () => undefined };
    await ensureOfferPrice({ prices, products } as unknown as StripeClient, store, {
      stripeAccountId: 'a',
      bundleOfferId: 'o',
      amountMinor: 120000,
      currency: 'COP',
      interval: 'month',
      intervalCount: 1,
      productName: 'x',
      image: null,
      landingPageId: 'lp',
    });
    expect((prices.create.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ unit_amount: 12000000, currency: 'cop' });

    const subCreate = vi.fn(async () => ({ id: 'sub_1', status: 'incomplete', latest_invoice: { id: 'in_1', amount_due: 12500000, confirmation_secret: { client_secret: 'pi_a_secret_b' } } }));
    const ref = await createIncompleteSubscription({ subscriptions: { create: subCreate } } as unknown as StripeClient, {
      customerId: 'c',
      priceId: 'price_1',
      currency: 'COP',
      shipping: { amountMinor: 5000, productId: 'p' },
      metadata: {},
      idempotencyKey: 'k',
    });
    expect((subCreate.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      add_invoice_items: [{ price_data: { unit_amount: 500000 } }],
    });
    expect(ref.amountDueMinor).toBe(125000);
  });
});

describe('recorrência anual (REQ-001)', () => {
  it('year aceita só contagem 1; demais intervalos 1–12', () => {
    expect(isValidIntervalCount(1, 'year')).toBe(true);
    expect(isValidIntervalCount(2, 'year')).toBe(false);
    expect(isValidIntervalCount(12, 'year')).toBe(false);
    expect(isValidIntervalCount(12, 'month')).toBe(true);
    expect(isValidIntervalCount(12, 'week')).toBe(true);
    expect(isValidIntervalCount(13, 'month')).toBe(false);
  });
});

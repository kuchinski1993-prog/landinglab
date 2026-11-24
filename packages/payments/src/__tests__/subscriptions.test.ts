import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import {
  CheckoutQuoteError,
  PortalNotConfiguredError,
  STRIPE_SUBSCRIPTION_WEBHOOK_EVENTS,
  STRIPE_WEBHOOK_EVENTS,
  SUBSCRIPTION_PERMISSION_WARNING,
  cancelIncompleteSubscription,
  createIncompleteSubscription,
  createPortalSession,
  ensureOfferPrice,
  ensureShippingProduct,
  formatInterval,
  invoicePaymentIntentId,
  paymentIntentIdFromSecret,
  readInvoice,
  readSubscription,
  recurringUnitAmount,
  subscriptionStrings,
  testStripeConnection,
  voidOpenInvoice,
  type OfferPriceKey,
  type OfferPriceRef,
  type OfferPriceStore,
  type StripeClient,
} from '../index.js';

function memoryStore(): OfferPriceStore & { rows: Array<OfferPriceKey & OfferPriceRef> } {
  const rows: Array<OfferPriceKey & OfferPriceRef> = [];
  const same = (a: OfferPriceKey, b: OfferPriceKey) =>
    a.stripeAccountId === b.stripeAccountId &&
    a.bundleOfferId === b.bundleOfferId &&
    a.amountMinor === b.amountMinor &&
    a.currency === b.currency &&
    a.interval === b.interval &&
    a.intervalCount === b.intervalCount;
  return {
    rows,
    async find(key) {
      const row = rows.find((r) => same(r, key));
      return row ? { stripeProductId: row.stripeProductId, stripePriceId: row.stripePriceId } : null;
    },
    async findProduct(accountId, offerId) {
      return rows.find((r) => r.stripeAccountId === accountId && r.bundleOfferId === offerId)?.stripeProductId ?? null;
    },
    async save(key, ref) {
      rows.push({ ...key, ...ref });
    },
  };
}

const baseInput = {
  stripeAccountId: 'acc-1',
  bundleOfferId: 'offer-1',
  amountMinor: 3192,
  currency: 'eur',
  interval: 'month' as const,
  intervalCount: 1,
  productName: 'Spicy Cubes',
  image: 'https://cdn.example.com/p.png',
  landingPageId: 'lp-1',
};

describe('recurringUnitAmount (O2: desconto em todas as faturas)', () => {
  it('sem desconto = preço cheio; 20% e 99% aplicados', () => {
    expect(recurringUnitAmount(3990, 0)).toBe(3990);
    expect(recurringUnitAmount(3990, null)).toBe(3990);
    expect(recurringUnitAmount(3990, 20)).toBe(3192);
    expect(recurringUnitAmount(3990, 99)).toBe(40);
  });

  it('arredonda ao minor mais próximo (moeda zero-decimal incluída)', () => {
    // JPY: 7980 = ¥7,980 — o cálculo é o mesmo sobre a unidade mínima.
    expect(recurringUnitAmount(7980, 15)).toBe(6783);
    expect(recurringUnitAmount(999, 33)).toBe(669); // 669.33 → 669
    expect(recurringUnitAmount(1005, 50)).toBe(503); // 502.5 → 503
  });

  it('nunca resulta em preço ≤ 0 e recusa entradas inválidas', () => {
    expect(() => recurringUnitAmount(1, 99)).toThrow(CheckoutQuoteError);
    expect(() => recurringUnitAmount(0, 0)).toThrow(CheckoutQuoteError);
    expect(() => recurringUnitAmount(1000, 100)).toThrow(CheckoutQuoteError);
    expect(() => recurringUnitAmount(1000, -1)).toThrow(CheckoutQuoteError);
    expect(() => recurringUnitAmount(10.5, 0)).toThrow(CheckoutQuoteError);
  });
});

describe('ensureOfferPrice (AC5)', () => {
  function client() {
    return {
      products: { create: vi.fn(async () => ({ id: 'prod_1' })) },
      prices: { create: vi.fn(async () => ({ id: `price_${Math.random().toString(36).slice(2, 8)}` })) },
    };
  }

  it('cria Product + Price recorrente com idempotency key e grava no cache', async () => {
    const c = client();
    const store = memoryStore();
    const ref = await ensureOfferPrice(c as unknown as StripeClient, store, baseInput);
    expect(ref.created).toBe(true);
    expect(c.products.create).toHaveBeenCalledTimes(1);
    const [productParams, productOpts] = c.products.create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(productParams).toMatchObject({
      name: 'Spicy Cubes',
      images: ['https://cdn.example.com/p.png'],
      metadata: { landing_page_id: 'lp-1', bundle_offer_id: 'offer-1', source: 'landinglab' },
    });
    expect(productOpts.idempotencyKey).toMatch(/^ll-product-acc-1-offer-1-/);
    const [priceParams, priceOpts] = c.prices.create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(priceParams).toMatchObject({
      product: 'prod_1',
      currency: 'eur',
      unit_amount: 3192,
      recurring: { interval: 'month', interval_count: 1 },
    });
    expect(priceOpts.idempotencyKey).toBe('ll-price-acc-1-offer-1-prod_1-3192-EUR-month-1');
    expect(store.rows).toHaveLength(1);
  });

  it('mesmos valores reutilizam o cache sem chamar a Stripe', async () => {
    const c = client();
    const store = memoryStore();
    const first = await ensureOfferPrice(c as unknown as StripeClient, store, baseInput);
    const again = await ensureOfferPrice(c as unknown as StripeClient, store, baseInput);
    expect(again).toEqual({ ...first, created: false });
    expect(c.prices.create).toHaveBeenCalledTimes(1);
  });

  it('valor diferente gera Price novo no mesmo Product (antigo não é alterado)', async () => {
    const c = client();
    const store = memoryStore();
    const first = await ensureOfferPrice(c as unknown as StripeClient, store, baseInput);
    const second = await ensureOfferPrice(c as unknown as StripeClient, store, { ...baseInput, amountMinor: 2990 });
    expect(c.products.create).toHaveBeenCalledTimes(1);
    expect(c.prices.create).toHaveBeenCalledTimes(2);
    expect(second.stripeProductId).toBe(first.stripeProductId);
    expect(second.stripePriceId).not.toBe(first.stripePriceId);
    expect(store.rows).toHaveLength(2);
  });

  it('falha da Stripe propaga e não grava cache', async () => {
    const c = client();
    c.prices.create.mockRejectedValueOnce(new Error('boom'));
    const store = memoryStore();
    await expect(ensureOfferPrice(c as unknown as StripeClient, store, baseInput)).rejects.toThrow('boom');
    expect(store.rows).toHaveLength(0);
  });
});

describe('ensureShippingProduct', () => {
  it('reusa o Product de frete existente', async () => {
    const c = { products: { retrieve: vi.fn(async () => ({ id: 'landinglab_shipping' })), create: vi.fn() } };
    expect(await ensureShippingProduct(c as unknown as StripeClient, 'Spedizione')).toBe('landinglab_shipping');
    expect(c.products.create).not.toHaveBeenCalled();
  });

  it('cria com ID fixo quando não existe', async () => {
    const missing = new Stripe.errors.StripeInvalidRequestError({ message: 'No such product', type: 'invalid_request_error' });
    (missing as unknown as { code: string }).code = 'resource_missing';
    const c = {
      products: {
        retrieve: vi.fn(async () => {
          throw missing;
        }),
        create: vi.fn(async (p: { id: string }) => ({ id: p.id })),
      },
    };
    expect(await ensureShippingProduct(c as unknown as StripeClient, 'Spedizione')).toBe('landinglab_shipping');
    expect(c.products.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'landinglab_shipping', name: 'Spedizione' }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });
});

describe('createIncompleteSubscription (AC6)', () => {
  const subscription = {
    id: 'sub_1',
    status: 'incomplete',
    latest_invoice: {
      id: 'in_1',
      amount_due: 3782,
      confirmation_secret: { client_secret: 'pi_abc_secret_xyz', type: 'payment_intent' },
      payments: { data: [{ is_default: true, status: 'open', payment: { type: 'payment_intent', payment_intent: 'pi_abc' } }] },
    },
  };

  it('default_incomplete + save_default_payment_method + frete só na 1ª fatura + expand do confirmation_secret', async () => {
    const create = vi.fn(async () => subscription);
    const c = { subscriptions: { create } };
    const ref = await createIncompleteSubscription(c as unknown as StripeClient, {
      customerId: 'cus_1',
      priceId: 'price_1',
      currency: 'EUR',
      shipping: { amountMinor: 590, productId: 'landinglab_shipping' },
      metadata: { checkout_session_id: 's1', source: 'landinglab' },
      idempotencyKey: 'll-sub-s1',
    });
    const [params, opts] = create.mock.calls[0] as unknown as [Record<string, unknown>, { idempotencyKey: string }];
    expect(params).toMatchObject({
      customer: 'cus_1',
      items: [{ price: 'price_1' }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      add_invoice_items: [{ price_data: { currency: 'eur', product: 'landinglab_shipping', unit_amount: 590 } }],
      metadata: { checkout_session_id: 's1', source: 'landinglab' },
      expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payments'],
    });
    expect(opts.idempotencyKey).toBe('ll-sub-s1');
    expect(ref).toEqual({
      subscriptionId: 'sub_1',
      status: 'incomplete',
      invoiceId: 'in_1',
      clientSecret: 'pi_abc_secret_xyz',
      paymentIntentId: 'pi_abc',
      amountDueMinor: 3782,
    });
  });

  it('frete grátis não adiciona item avulso', async () => {
    const create = vi.fn(async () => subscription);
    await createIncompleteSubscription({ subscriptions: { create } } as unknown as StripeClient, {
      customerId: 'cus_1',
      priceId: 'price_1',
      currency: 'EUR',
      shipping: { amountMinor: 0, productId: 'landinglab_shipping' },
      metadata: {},
      idempotencyKey: 'k',
    });
    const [params] = create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(params['add_invoice_items']).toBeUndefined();
  });

  it('sem payments expandido, deriva o PaymentIntent do client secret', () => {
    expect(paymentIntentIdFromSecret('pi_3Abc_secret_def')).toBe('pi_3Abc');
    expect(paymentIntentIdFromSecret('seti_1_secret_x')).toBeNull();
    expect(paymentIntentIdFromSecret(null)).toBeNull();
  });

  it('cancelIncompleteSubscription ignora assinatura já encerrada', async () => {
    const err = new Stripe.errors.StripeInvalidRequestError({ message: 'already canceled', type: 'invalid_request_error' });
    const c = { subscriptions: { cancel: vi.fn(async () => Promise.reject(err)) } };
    await expect(cancelIncompleteSubscription(c as unknown as StripeClient, 'sub_1')).resolves.toBeUndefined();
  });

  it('SUB-005: voidOpenInvoice anula a fatura aberta e tolera fatura já paga/anulada', async () => {
    const ok = { invoices: { voidInvoice: vi.fn(async () => ({ id: 'in_1', status: 'void' })) } };
    expect(await voidOpenInvoice(ok as unknown as StripeClient, 'in_1')).toBe(true);
    expect(ok.invoices.voidInvoice).toHaveBeenCalledWith('in_1');
    const err = new Stripe.errors.StripeInvalidRequestError({ message: 'already paid', type: 'invalid_request_error' });
    const paid = { invoices: { voidInvoice: vi.fn(async () => Promise.reject(err)) } };
    expect(await voidOpenInvoice(paid as unknown as StripeClient, 'in_1')).toBe(false);
    const down = { invoices: { voidInvoice: vi.fn(async () => Promise.reject(new Error('network'))) } };
    await expect(voidOpenInvoice(down as unknown as StripeClient, 'in_1')).rejects.toThrow('network');
  });

  it('invoicePaymentIntentId prefere o pagamento pago', async () => {
    const c = {
      invoices: {
        retrieve: vi.fn(async () => ({
          payments: {
            data: [
              { status: 'failed', is_default: false, payment: { payment_intent: 'pi_old' } },
              { status: 'paid', is_default: true, payment: { payment_intent: { id: 'pi_new' } } },
            ],
          },
        })),
      },
    };
    expect(await invoicePaymentIntentId(c as unknown as StripeClient, 'in_1')).toBe('pi_new');
    expect(c.invoices.retrieve).toHaveBeenCalledWith('in_1', { expand: ['payments'] });
  });
});

describe('readInvoice / readSubscription (webhook)', () => {
  it('lê billing_reason, assinatura (parent.subscription_details) e fim do período', () => {
    const info = readInvoice({
      id: 'in_2',
      billing_reason: 'subscription_cycle',
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: { source: 'landinglab' } } },
      customer: 'cus_1',
      amount_paid: 3192,
      amount_due: 3192,
      currency: 'eur',
      attempt_count: 1,
      lines: { data: [{ period: { start: 1_700_000_000, end: 1_702_592_000 } }] },
    });
    expect(info).toMatchObject({
      id: 'in_2',
      billingReason: 'subscription_cycle',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      amountPaidMinor: 3192,
      currency: 'EUR',
      metadata: { source: 'landinglab' },
    });
    expect(info.periodEnd?.toISOString()).toBe(new Date(1_702_592_000 * 1000).toISOString());
  });

  it('lê motivo do cancelamento', () => {
    const info = readSubscription({
      id: 'sub_1',
      status: 'canceled',
      customer: { id: 'cus_1' },
      cancellation_details: { reason: 'payment_failed' },
      canceled_at: 1_700_000_000,
      metadata: { source: 'landinglab' },
    });
    expect(info).toMatchObject({ id: 'sub_1', status: 'canceled', customerId: 'cus_1', cancelReason: 'payment_failed' });
  });

  it('E2E B-5: ended_at (fim efetivo) separado de canceled_at; cancelamento agendado e fim do período', () => {
    const ended = readSubscription({ id: 'sub_1', status: 'canceled', canceled_at: 1_796_860_800, ended_at: 1_797_033_600 });
    expect(ended.canceledAt?.toISOString()).toBe(new Date(1_796_860_800 * 1000).toISOString());
    expect(ended.endedAt?.toISOString()).toBe(new Date(1_797_033_600 * 1000).toISOString());

    // Portal "cancelar no fim do período" (API nova: período nos itens).
    const scheduled = readSubscription({
      id: 'sub_2',
      status: 'active',
      cancel_at_period_end: true,
      cancel_at: null,
      ended_at: null,
      items: { data: [{ current_period_end: 1_799_712_000 }] },
    });
    expect(scheduled).toMatchObject({ cancelAtPeriodEnd: true, endedAt: null });
    expect(scheduled.cancelAt?.toISOString()).toBe(new Date(1_799_712_000 * 1000).toISOString());
    expect(scheduled.currentPeriodEnd?.toISOString()).toBe(new Date(1_799_712_000 * 1000).toISOString());

    // cancel_at explícito (API antiga: current_period_end no topo) e reativação.
    expect(readSubscription({ id: 's', cancel_at: 1_800_000_000, current_period_end: 1_799_000_000 }).cancelAt?.getTime()).toBe(1_800_000_000_000);
    expect(readSubscription({ id: 's', cancel_at_period_end: false, cancel_at: null }).cancelAt).toBeNull();
  });
});

describe('createPortalSession (AC11)', () => {
  it('cria a sessão com return_url e devolve a URL', async () => {
    const create = vi.fn(async () => ({ url: 'https://billing.stripe.com/p/session/x' }));
    const url = await createPortalSession({ billingPortal: { sessions: { create } } } as unknown as StripeClient, {
      customerId: 'cus_1',
      returnUrl: 'https://shop.example/rastreio',
      locale: 'it',
    });
    expect(url).toBe('https://billing.stripe.com/p/session/x');
    expect(create).toHaveBeenCalledWith({ customer: 'cus_1', return_url: 'https://shop.example/rastreio', locale: 'it' });
  });

  it('Portal não configurado → PortalNotConfiguredError', async () => {
    const err = new Stripe.errors.StripeInvalidRequestError({
      message: "You can't create a portal session in test mode until you save your customer portal settings in test mode at https://dashboard.stripe.com/test/settings/billing/portal. (No configuration provided and your test mode default configuration has not been created.)",
      type: 'invalid_request_error',
    });
    const create = vi.fn(async () => Promise.reject(err));
    await expect(
      createPortalSession({ billingPortal: { sessions: { create } } } as unknown as StripeClient, {
        customerId: 'cus_1',
        returnUrl: 'https://x/rastreio',
      }),
    ).rejects.toBeInstanceOf(PortalNotConfiguredError);
  });
});

describe('eventos e permissões (AC14/AC17)', () => {
  it('STRIPE_WEBHOOK_EVENTS inclui os 3 eventos de assinatura e nenhum de disputa', () => {
    expect(STRIPE_SUBSCRIPTION_WEBHOOK_EVENTS).toEqual(['invoice.paid', 'invoice.payment_failed', 'customer.subscription.deleted']);
    for (const ev of STRIPE_SUBSCRIPTION_WEBHOOK_EVENTS) expect(STRIPE_WEBHOOK_EVENTS).toContain(ev);
    expect(STRIPE_WEBHOOK_EVENTS.some((e) => e.includes('dispute'))).toBe(false);
  });

  it('Testar avisa quando a chave não tem permissão de assinatura, sem invalidar a chave', async () => {
    const denied = () => {
      throw new Stripe.errors.StripePermissionError({ message: 'no perm', type: 'invalid_request_error' });
    };
    const client = {
      accounts: { retrieveCurrent: async () => ({ id: 'acct_1', charges_enabled: true, default_currency: 'eur' }) },
      subscriptions: { list: denied },
    } as unknown as StripeClient;
    const result = await testStripeConnection(client);
    expect(result.ok).toBe(true);
    expect(result.subscriptionReady).toBe(false);
    expect(result.message).toContain(SUBSCRIPTION_PERMISSION_WARNING);
  });

  it('chave com todas as permissões não recebe aviso', async () => {
    const ok = async () => ({ data: [] });
    const client = {
      accounts: { retrieveCurrent: async () => ({ id: 'acct_1', charges_enabled: true, default_currency: 'eur' }) },
      subscriptions: { list: ok },
      customers: { list: ok },
      prices: { list: ok },
      billingPortal: { configurations: { list: ok } },
    } as unknown as StripeClient;
    const result = await testStripeConnection(client);
    expect(result.subscriptionReady).toBe(true);
    expect(result.message).not.toContain('Aviso');
  });
});

describe('textos de assinatura (O8: it + fallback en)', () => {
  it('italiano e fallback inglês', () => {
    expect(subscriptionStrings('it').badge).toBe('Abbonamento');
    expect(subscriptionStrings('de').badge).toBe('Subscription');
    expect(formatInterval('month', 1, 'it')).toBe('ogni mese');
    expect(formatInterval('week', 2, 'it')).toBe('ogni 2 settimane');
    expect(formatInterval('month', 3, 'fr')).toBe('every 3 months');
  });
});

describe('link assinado de gestão (AC11/AC18)', async () => {
  const { emailHash, manageLinkSecret, manageLinkUrl, signManageToken, verifyManageToken } = await import('../index.js');
  const SECRET = 'x'.repeat(40);
  const NOW = new Date('2026-10-06T12:00:00Z');

  it('token válido devolve assinatura e hash do e-mail', () => {
    const token = signManageToken(SECRET, { subscriptionId: 'sub-uuid', email: ' Mario@Example.com ' }, NOW);
    const payload = verifyManageToken(SECRET, token, NOW);
    expect(payload?.subscriptionId).toBe('sub-uuid');
    expect(payload?.emailHash).toBe(emailHash('mario@example.com'));
    expect(token).not.toContain('mario');
  });

  it('expirado, adulterado, outra chave ou lixo → null', () => {
    const token = signManageToken(SECRET, { subscriptionId: 'sub-uuid', email: 'a@b.it' }, NOW, 60);
    expect(verifyManageToken(SECRET, token, new Date(NOW.getTime() + 61_000))).toBeNull();
    const [body, mac] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ v: 1, s: 'other', e: 'x', x: 9_999_999_999 })).toString('base64url');
    expect(verifyManageToken(SECRET, `${forged}.${mac}`, NOW)).toBeNull();
    expect(verifyManageToken(SECRET, `${body}.${mac.slice(0, -2)}AA`, NOW)).toBeNull();
    expect(verifyManageToken('y'.repeat(40), token, NOW)).toBeNull();
    expect(verifyManageToken(SECRET, 'abc', NOW)).toBeNull();
    expect(verifyManageToken(SECRET, undefined, NOW)).toBeNull();
  });

  it('segredo: env própria, senão derivado do VAULT_SECRET; curto/ausente = desativado', () => {
    expect(manageLinkSecret({ LANDINGLAB_SUBSCRIPTION_LINK_SECRET: SECRET })).toBe(SECRET);
    const derived = manageLinkSecret({}, 'v'.repeat(40));
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toBe('v'.repeat(40));
    expect(manageLinkSecret({ LANDINGLAB_SUBSCRIPTION_LINK_SECRET: 'short' }, '')).toBeNull();
  });

  it('URL absoluta só para hostname simples', () => {
    expect(manageLinkUrl('shop.example', 'a.b')).toBe('https://shop.example/assinatura/gerir?t=a.b');
    expect(manageLinkUrl('evil.com/x?', 'a.b')).toBeNull();
    expect(manageLinkUrl(null, 'a.b')).toBeNull();
  });
});

describe('createSubscriptionCustomer', async () => {
  const { createSubscriptionCustomer } = await import('../index.js');
  const address = { line1: 'Via Roma 1', city: 'Roma', postal_code: '00100', country: 'IT' };

  it('cria Customer com endereço de entrega e idempotency key; sem test clock por padrão', async () => {
    const create = vi.fn(async () => ({ id: 'cus_1' }));
    const clocks = vi.fn();
    const c = { customers: { create }, testHelpers: { testClocks: { create: clocks } } };
    const id = await createSubscriptionCustomer(c as unknown as StripeClient, {
      email: 'a@b.it',
      name: 'Mario',
      address,
      metadata: { checkout_session_id: 's1' },
      idempotencyKey: 'k1',
    });
    expect(id).toBe('cus_1');
    expect(clocks).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.it', shipping: expect.objectContaining({ name: 'Mario', address }) }),
      { idempotencyKey: 'k1' },
    );
    const [params] = create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(params['test_clock']).toBeUndefined();
  });

  it('testClock: cria o relógio e vincula ao Customer', async () => {
    const create = vi.fn(async () => ({ id: 'cus_2' }));
    const clocks = vi.fn(async () => ({ id: 'clock_1' }));
    const c = { customers: { create }, testHelpers: { testClocks: { create: clocks } } };
    await createSubscriptionCustomer(c as unknown as StripeClient, {
      email: 'a@b.it',
      name: 'Mario',
      address,
      metadata: {},
      idempotencyKey: 'k2',
      testClock: true,
    });
    expect(clocks).toHaveBeenCalledWith(expect.objectContaining({ frozen_time: expect.any(Number) }), { idempotencyKey: 'k2-clock' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ test_clock: 'clock_1' }), { idempotencyKey: 'k2' });
  });
});

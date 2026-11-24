// Assinaturas Stripe da LandingLab (Story 15.6): Product/Price recorrente por
// oferta (com cache por conta), Customer, Subscription `default_incomplete`
// com frete só na 1ª fatura, PaymentIntent da fatura e sessão do Customer Portal.
//
// Spike (API 2026-09-30 / stripe-node 23): o client secret da 1ª fatura vem de
// `latest_invoice.confirmation_secret.client_secret` (expand) — `Invoice` não
// tem mais `payment_intent`; o PaymentIntent da fatura é lido em
// `invoice.payments[].payment.payment_intent` (expand `payments`).
// A fatura aponta a assinatura em `parent.subscription_details.subscription`.
import { createHash } from 'node:crypto';

import type Stripe from 'stripe';

import type { SubscriptionInterval } from './checkout.js';
import { fromStripeAmount, toStripeAmount } from './currency.js';
import { stripeErrorType, type StripeClient } from './stripe-client.js';

/** Hash curto e estável dos parâmetros: entra na idempotency key. */
export function paramsFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

// ─── Product / Price recorrente ─────────────────────────────────────────────

export interface OfferPriceKey {
  stripeAccountId: string;
  bundleOfferId: string;
  /** Na unidade da Stripe (= unidade da app, exceto moedas como COP). */
  amountMinor: number;
  currency: string;
  interval: SubscriptionInterval;
  intervalCount: number;
}

export interface OfferPriceRef {
  stripeProductId: string;
  stripePriceId: string;
}

/** Cache local (stripe_offer_prices). */
export interface OfferPriceStore {
  find(key: OfferPriceKey): Promise<OfferPriceRef | null>;
  /** Product já criado para a oferta nesta conta (qualquer Price). */
  findProduct(stripeAccountId: string, bundleOfferId: string): Promise<string | null>;
  save(key: OfferPriceKey, ref: OfferPriceRef): Promise<void>;
}

export interface EnsureOfferPriceInput extends OfferPriceKey {
  productName: string;
  image: string | null;
  landingPageId: string;
}

/**
 * Obtém ou cria, na conta escolhida, o Product da oferta e o Price recorrente
 * com os valores informados. Mesmos valores → reuso (cache); valores novos →
 * Price novo (o antigo não é alterado nem arquivado).
 */
export async function ensureOfferPrice(
  client: StripeClient,
  store: OfferPriceStore,
  input: EnsureOfferPriceInput,
): Promise<OfferPriceRef & { created: boolean }> {
  // Chave do cache no valor da Stripe (QA 15.3 MNT-004): para moedas em que a
  // Stripe usa outras casas decimais (COP), um Price criado antes da correção
  // (valor 100x menor) não é reaproveitado.
  const key: OfferPriceKey = {
    stripeAccountId: input.stripeAccountId,
    bundleOfferId: input.bundleOfferId,
    amountMinor: toStripeAmount(input.amountMinor, input.currency),
    currency: input.currency.toUpperCase(),
    interval: input.interval,
    intervalCount: input.intervalCount,
  };
  const cached = await store.find(key);
  if (cached) return { ...cached, created: false };

  let productId = await store.findProduct(input.stripeAccountId, input.bundleOfferId);
  if (!productId) {
    const productParams = {
      name: input.productName.slice(0, 250),
      ...(input.image && /^https:\/\//.test(input.image) ? { images: [input.image] } : {}),
      metadata: { landing_page_id: input.landingPageId, bundle_offer_id: input.bundleOfferId, source: 'landinglab' },
    };
    const product = await client.products.create(productParams, {
      idempotencyKey: `ll-product-${input.stripeAccountId}-${input.bundleOfferId}-${paramsFingerprint(productParams)}`,
    });
    productId = product.id;
  }

  const price = await client.prices.create(
    {
      product: productId,
      currency: key.currency.toLowerCase(),
      unit_amount: key.amountMinor,
      recurring: { interval: key.interval, interval_count: key.intervalCount },
      metadata: { landing_page_id: input.landingPageId, bundle_offer_id: input.bundleOfferId, source: 'landinglab' },
    },
    {
      idempotencyKey: `ll-price-${key.stripeAccountId}-${key.bundleOfferId}-${productId}-${key.amountMinor}-${key.currency}-${key.interval}-${key.intervalCount}`,
    },
  );
  const ref = { stripeProductId: productId, stripePriceId: price.id };
  await store.save(key, ref);
  return { ...ref, created: true };
}

/** ID fixo do Product "Spedizione" usado no item de frete da 1ª fatura. */
export const SHIPPING_PRODUCT_ID = 'landinglab_shipping';

/** Garante o Product de frete na conta (ID próprio: sem cache local). */
export async function ensureShippingProduct(client: StripeClient, name: string): Promise<string> {
  try {
    const existing = await client.products.retrieve(SHIPPING_PRODUCT_ID);
    return existing.id;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (stripeErrorType(error) !== 'StripeInvalidRequestError' || code !== 'resource_missing') throw error;
  }
  try {
    const created = await client.products.create(
      { id: SHIPPING_PRODUCT_ID, name, metadata: { source: 'landinglab', kind: 'shipping' } },
      { idempotencyKey: `ll-shipping-product-${SHIPPING_PRODUCT_ID}` },
    );
    return created.id;
  } catch (error) {
    // Corrida entre dois checkouts: o outro criou primeiro.
    if ((error as { code?: string }).code === 'resource_already_exists') return SHIPPING_PRODUCT_ID;
    throw error;
  }
}

// ─── Customer + Subscription ────────────────────────────────────────────────

export interface SubscriptionCustomerInput {
  email: string;
  name: string;
  phone?: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    postal_code: string;
    state?: string;
    country: string;
  };
  metadata: Record<string, string>;
  idempotencyKey: string;
  /**
   * Só contas em modo teste (LANDINGLAB_STRIPE_TEST_CLOCKS=1): cria um Test
   * Clock para o cliente, permitindo simular renovações no Dashboard (AC16).
   */
  testClock?: boolean;
}

export async function createSubscriptionCustomer(client: StripeClient, input: SubscriptionCustomerInput): Promise<string> {
  let testClockId: string | undefined;
  if (input.testClock) {
    const clock = await client.testHelpers.testClocks.create(
      { frozen_time: Math.floor(Date.now() / 1000), name: `landinglab ${input.metadata['checkout_session_id'] ?? ''}`.trim().slice(0, 300) },
      { idempotencyKey: `${input.idempotencyKey}-clock` },
    );
    testClockId = clock.id;
  }
  const customer = await client.customers.create(
    {
      ...(testClockId ? { test_clock: testClockId } : {}),
      email: input.email,
      name: input.name,
      ...(input.phone ? { phone: input.phone } : {}),
      address: input.address,
      shipping: { name: input.name, address: input.address, ...(input.phone ? { phone: input.phone } : {}) },
      metadata: input.metadata,
    },
    { idempotencyKey: input.idempotencyKey },
  );
  return customer.id;
}

/**
 * Atualiza nome/telefone/endereço do Customer numa nova tentativa do mesmo
 * checkout (QA 15.6 REL-002) — o pedido e as renovações usam o endereço
 * gravado na sessão; o Customer fica coerente para o Portal/recibos.
 */
export async function updateSubscriptionCustomer(
  client: StripeClient,
  customerId: string,
  input: Pick<SubscriptionCustomerInput, 'name' | 'phone' | 'address'>,
): Promise<void> {
  await client.customers.update(customerId, {
    name: input.name,
    ...(input.phone ? { phone: input.phone } : {}),
    address: input.address,
    shipping: { name: input.name, address: input.address, ...(input.phone ? { phone: input.phone } : {}) },
  });
}

export interface IncompleteSubscriptionInput {
  customerId: string;
  priceId: string;
  currency: string;
  /** Frete cobrado só na 1ª fatura (decisão O3); 0/omitido = sem item. */
  shipping?: { amountMinor: number; productId: string } | null;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface IncompleteSubscriptionRef {
  subscriptionId: string;
  status: string;
  invoiceId: string | null;
  /** latest_invoice.confirmation_secret.client_secret → stripe.confirmPayment. */
  clientSecret: string;
  paymentIntentId: string | null;
  amountDueMinor: number | null;
}

/** pi_123_secret_abc → pi_123 (fallback quando `payments` não vem expandido). */
export function paymentIntentIdFromSecret(clientSecret: string | null | undefined): string | null {
  const match = /^(pi_[A-Za-z0-9]+)_secret_/.exec(clientSecret ?? '');
  return match?.[1] ?? null;
}

function invoicePaymentIntent(invoice: Pick<Stripe.Invoice, 'payments'> | null | undefined): string | null {
  const payments = invoice?.payments?.data ?? [];
  const preferred = payments.find((p) => p.status === 'paid') ?? payments.find((p) => p.is_default) ?? payments[0];
  const pi = preferred?.payment?.payment_intent;
  if (!pi) return null;
  return typeof pi === 'string' ? pi : pi.id;
}

/**
 * Subscription `default_incomplete`: a 1ª fatura fica aberta até o browser
 * confirmar o PaymentIntent dela (Payment Element). O método de pagamento é
 * salvo na assinatura para as renovações off-session.
 */
export async function createIncompleteSubscription(
  client: StripeClient,
  input: IncompleteSubscriptionInput,
): Promise<IncompleteSubscriptionRef> {
  const subscription = await client.subscriptions.create(
    {
      customer: input.customerId,
      items: [{ price: input.priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      ...(input.shipping && input.shipping.amountMinor > 0
        ? {
            add_invoice_items: [
              {
                price_data: {
                  currency: input.currency.toLowerCase(),
                  product: input.shipping.productId,
                  unit_amount: toStripeAmount(input.shipping.amountMinor, input.currency),
                },
                metadata: { kind: 'shipping', source: 'landinglab' },
              },
            ],
          }
        : {}),
      metadata: input.metadata,
      expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payments'],
    },
    { idempotencyKey: input.idempotencyKey },
  );
  const invoice = typeof subscription.latest_invoice === 'object' ? subscription.latest_invoice : null;
  const clientSecret = invoice?.confirmation_secret?.client_secret ?? '';
  return {
    subscriptionId: subscription.id,
    status: subscription.status,
    invoiceId: invoice?.id ?? (typeof subscription.latest_invoice === 'string' ? subscription.latest_invoice : null),
    clientSecret,
    paymentIntentId: invoicePaymentIntent(invoice) ?? paymentIntentIdFromSecret(clientSecret),
    amountDueMinor: typeof invoice?.amount_due === 'number' ? fromStripeAmount(invoice.amount_due, input.currency) : null,
  };
}

export interface SubscriptionStateRef {
  id: string;
  status: string;
  latestInvoiceId: string | null;
  clientSecret: string;
  paymentIntentId: string | null;
  /** Valor pago da última fatura (unidade da app); null se não informado/0. */
  latestInvoiceAmountPaidMinor: number | null;
}

export async function retrieveSubscriptionState(client: StripeClient, subscriptionId: string): Promise<SubscriptionStateRef> {
  const sub = await client.subscriptions.retrieve(subscriptionId, {
    expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payments'],
  });
  const invoice = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
  const clientSecret = invoice?.confirmation_secret?.client_secret ?? '';
  return {
    id: sub.id,
    status: sub.status,
    latestInvoiceId: invoice?.id ?? (typeof sub.latest_invoice === 'string' ? sub.latest_invoice : null),
    clientSecret,
    paymentIntentId: invoicePaymentIntent(invoice) ?? paymentIntentIdFromSecret(clientSecret),
    latestInvoiceAmountPaidMinor:
      invoice && typeof invoice.amount_paid === 'number' && invoice.amount_paid > 0 && invoice.currency
        ? fromStripeAmount(invoice.amount_paid, invoice.currency)
        : null,
  };
}

/** Cancela uma Subscription `incomplete` abandonada (nova tentativa no mesmo checkout). */
export async function cancelIncompleteSubscription(client: StripeClient, subscriptionId: string): Promise<void> {
  try {
    await client.subscriptions.cancel(subscriptionId);
  } catch (error) {
    // Já cancelada/expirada: nada a fazer.
    if (stripeErrorType(error) === 'StripeInvalidRequestError') return;
    throw error;
  }
}

/**
 * QA 15.6 SUB-005 — cancelar uma Subscription `incomplete` não anula a fatura
 * aberta: o client secret antigo ainda conseguiria pagá-la. Anula a fatura
 * (o PaymentIntent dela é cancelado junto). Já paga/anulada/inexistente → false.
 */
export async function voidOpenInvoice(client: StripeClient, invoiceId: string): Promise<boolean> {
  try {
    await client.invoices.voidInvoice(invoiceId);
    return true;
  } catch (error) {
    if (stripeErrorType(error) === 'StripeInvalidRequestError') return false;
    throw error;
  }
}

/** PaymentIntent que pagou a fatura (para reembolso, charge.refunded e settlement). */
export async function invoicePaymentIntentId(client: StripeClient, invoiceId: string): Promise<string | null> {
  const invoice = await client.invoices.retrieve(invoiceId, { expand: ['payments'] });
  return invoicePaymentIntent(invoice);
}

// ─── Webhook: leitura de faturas/assinaturas ────────────────────────────────

export interface InvoiceInfo {
  id: string;
  billingReason: string | null;
  subscriptionId: string | null;
  customerId: string | null;
  amountPaidMinor: number;
  amountDueMinor: number;
  currency: string;
  attemptCount: number;
  /** Fim do período coberto pela fatura (linha da assinatura), se informado. */
  periodEnd: Date | null;
  metadata: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const id = asRecord(value)['id'];
  return typeof id === 'string' ? id : null;
}

/** Extrai o que importa de um `invoice.*` (objeto cru do evento). */
export function readInvoice(raw: unknown): InvoiceInfo {
  const inv = asRecord(raw);
  const parent = asRecord(inv['parent']);
  const details = asRecord(parent['subscription_details']);
  const lines = asRecord(inv['lines']);
  const data = Array.isArray(lines['data']) ? (lines['data'] as unknown[]) : [];
  let periodEnd: number | null = null;
  for (const line of data) {
    const end = asRecord(asRecord(line)['period'])['end'];
    if (typeof end === 'number' && (periodEnd === null || end > periodEnd)) periodEnd = end;
  }
  const meta = asRecord(details['metadata']);
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (typeof v === 'string') metadata[k] = v;
  const currency = String(inv['currency'] ?? '').toUpperCase();
  const amount = (value: unknown) => (currency ? fromStripeAmount(Number(value ?? 0), currency) : Number(value ?? 0));
  return {
    id: String(inv['id'] ?? ''),
    billingReason: typeof inv['billing_reason'] === 'string' ? (inv['billing_reason'] as string) : null,
    subscriptionId: idOf(details['subscription']) ?? idOf(inv['subscription']),
    customerId: idOf(inv['customer']),
    amountPaidMinor: amount(inv['amount_paid']),
    amountDueMinor: amount(inv['amount_due']),
    currency,
    attemptCount: Number(inv['attempt_count'] ?? 0),
    periodEnd: periodEnd !== null ? new Date(periodEnd * 1000) : null,
    metadata,
  };
}

export interface SubscriptionInfo {
  id: string;
  status: string;
  customerId: string | null;
  cancelReason: string | null;
  /** canceled_at (momento do pedido de cancelamento) ou, na falta, ended_at. */
  canceledAt: Date | null;
  /** ended_at — fim efetivo da assinatura (null enquanto viva). */
  endedAt: Date | null;
  /** Cancelamento agendado (cancel_at, ou fim do período com cancel_at_period_end). */
  cancelAt: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Fim do período atual (items.data[].current_period_end ou current_period_end legado). */
  currentPeriodEnd: Date | null;
  metadata: Record<string, string>;
}

/** Extrai o que importa de um `customer.subscription.*` (objeto cru do evento). */
export function readSubscription(raw: unknown): SubscriptionInfo {
  const sub = asRecord(raw);
  const details = asRecord(sub['cancellation_details']);
  const canceledAt = sub['canceled_at'] ?? sub['ended_at'];
  const meta = asRecord(sub['metadata']);
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (typeof v === 'string') metadata[k] = v;
  const toDate = (value: unknown) => (typeof value === 'number' && value > 0 ? new Date(value * 1000) : null);
  // API ≥ 2025-03 (basil): o período fica nos itens; antes, no topo.
  const items = asRecord(sub['items']);
  const itemList = Array.isArray(items['data']) ? (items['data'] as unknown[]) : [];
  let periodEnd: number | null = typeof sub['current_period_end'] === 'number' ? (sub['current_period_end'] as number) : null;
  for (const item of itemList) {
    const end = asRecord(item)['current_period_end'];
    if (typeof end === 'number' && (periodEnd === null || end > periodEnd)) periodEnd = end;
  }
  const currentPeriodEnd = toDate(periodEnd);
  const cancelAtPeriodEnd = sub['cancel_at_period_end'] === true;
  return {
    id: String(sub['id'] ?? ''),
    status: String(sub['status'] ?? ''),
    customerId: idOf(sub['customer']),
    cancelReason: typeof details['reason'] === 'string' ? (details['reason'] as string) : null,
    canceledAt: typeof canceledAt === 'number' ? new Date(canceledAt * 1000) : null,
    endedAt: toDate(sub['ended_at']),
    cancelAt: toDate(sub['cancel_at']) ?? (cancelAtPeriodEnd ? currentPeriodEnd : null),
    cancelAtPeriodEnd,
    currentPeriodEnd,
    metadata,
  };
}

// ─── Customer Portal ────────────────────────────────────────────────────────

export class PortalNotConfiguredError extends Error {
  constructor() {
    super('Customer Portal não configurado nesta conta Stripe.');
    this.name = 'PortalNotConfiguredError';
  }
}

/**
 * Sessão de vida curta do Customer Portal na conta de origem da assinatura.
 * Sem configuração do Portal salva na conta → PortalNotConfiguredError.
 */
export async function createPortalSession(
  client: StripeClient,
  input: { customerId: string; returnUrl: string; locale?: string | null },
): Promise<string> {
  try {
    const session = await client.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
      ...(input.locale ? { locale: input.locale as Stripe.BillingPortal.SessionCreateParams.Locale } : {}),
    });
    return session.url;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (stripeErrorType(error) === 'StripeInvalidRequestError' && message.includes('configuration')) {
      throw new PortalNotConfiguredError();
    }
    throw error;
  }
}

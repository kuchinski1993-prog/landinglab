// Operações Stripe do checkout (Story 15.3): PaymentIntent, domínios de
// carteira (Apple Pay / Google Pay) e valor liquidado na moeda da conta.
import { fromStripeAmount, toStripeAmount } from './currency.js';
import { stripeErrorType, type StripeClient } from './stripe-client.js';

export interface PaymentIntentInput {
  amountMinor: number;
  currency: string;
  description: string;
  metadata: Record<string, string>;
  /** Evita PaymentIntent duplicado em retries do mesmo checkout. */
  idempotencyKey: string;
}

export interface PaymentIntentRef {
  id: string;
  clientSecret: string;
  amountMinor: number;
  status: string;
}

export async function createPaymentIntent(client: StripeClient, input: PaymentIntentInput): Promise<PaymentIntentRef> {
  const pi = await client.paymentIntents.create(
    {
      amount: toStripeAmount(input.amountMinor, input.currency),
      currency: input.currency.toLowerCase(),
      description: input.description,
      metadata: input.metadata,
      automatic_payment_methods: { enabled: true },
    },
    { idempotencyKey: input.idempotencyKey },
  );
  return {
    id: pi.id,
    clientSecret: pi.client_secret ?? '',
    amountMinor: fromStripeAmount(pi.amount, pi.currency ?? input.currency),
    status: pi.status,
  };
}

/**
 * O que foi realmente cobrado num PaymentIntent pago (objeto cru do webhook
 * ou de paymentIntents.retrieve): `amount_received` na unidade da app e a
 * metadata (o checkout grava `shipping_method` a cada troca de frete).
 */
export interface PaymentIntentCharged {
  amountReceivedMinor: number | null;
  currency: string | null;
  metadata: Record<string, string>;
}

export function readPaymentIntentCharged(raw: unknown): PaymentIntentCharged {
  const pi = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const currency = typeof pi['currency'] === 'string' ? pi['currency'].toUpperCase() : null;
  const received = pi['amount_received'];
  const meta = pi['metadata'] && typeof pi['metadata'] === 'object' ? (pi['metadata'] as Record<string, unknown>) : {};
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (typeof v === 'string') metadata[k] = v;
  return {
    amountReceivedMinor:
      typeof received === 'number' && received > 0 && currency ? fromStripeAmount(received, currency) : null,
    currency,
    metadata,
  };
}

export interface ShippingDetails {
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
}

export async function updatePaymentIntent(
  client: StripeClient,
  id: string,
  input: { amountMinor: number; currency: string; metadata?: Record<string, string>; shipping?: ShippingDetails },
): Promise<PaymentIntentRef> {
  const pi = await client.paymentIntents.update(id, {
    amount: toStripeAmount(input.amountMinor, input.currency),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.shipping ? { shipping: input.shipping } : {}),
  });
  return {
    id: pi.id,
    clientSecret: pi.client_secret ?? '',
    amountMinor: fromStripeAmount(pi.amount, pi.currency ?? input.currency),
    status: pi.status,
  };
}

/**
 * Registra o domínio na conta para Apple Pay / Google Pay.
 * Já registrado conta como sucesso.
 */
export async function registerPaymentMethodDomain(client: StripeClient, domain: string): Promise<boolean> {
  try {
    await client.paymentMethodDomains.create({ domain_name: domain, enabled: true });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (stripeErrorType(error) === 'StripeInvalidRequestError' && message.includes('already')) return true;
    return false;
  }
}

export interface Settlement {
  amountMinor: number;
  currency: string;
}

/** Valor bruto convertido na moeda de saque da conta (balance_transaction). */
export async function retrieveSettlement(client: StripeClient, paymentIntentId: string): Promise<Settlement | null> {
  const pi = await client.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge.balance_transaction'],
  });
  const charge = pi.latest_charge;
  if (!charge || typeof charge === 'string') return null;
  const bt = charge.balance_transaction;
  if (!bt || typeof bt === 'string') return null;
  return { amountMinor: fromStripeAmount(bt.amount, bt.currency), currency: bt.currency.toUpperCase() };
}

export interface RefundInput {
  paymentIntentId: string;
  /** Omitido = saldo reembolsável inteiro (a Stripe calcula). */
  amountMinor?: number;
  /** Moeda do pedido (converte o valor para as casas decimais da Stripe). */
  currency: string;
  metadata?: Record<string, string>;
  /** Evita reembolso duplicado em duplo clique / retry. */
  idempotencyKey: string;
}

export interface RefundRef {
  id: string;
  amountMinor: number;
  currency: string;
  status: string | null;
}

/**
 * Reembolso total ou parcial do PaymentIntent (Story 15.4, D15).
 * O estado local do pedido só muda pelo webhook charge.refunded.
 */
export async function createRefund(client: StripeClient, input: RefundInput): Promise<RefundRef> {
  const refund = await client.refunds.create(
    {
      payment_intent: input.paymentIntentId,
      ...(input.amountMinor !== undefined ? { amount: toStripeAmount(input.amountMinor, input.currency) } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    { idempotencyKey: input.idempotencyKey },
  );
  return {
    id: refund.id,
    amountMinor: fromStripeAmount(refund.amount, refund.currency),
    currency: refund.currency.toUpperCase(),
    status: refund.status ?? null,
  };
}

// Verificação de assinatura dos webhooks Stripe (Story 15.1, AC8).
import Stripe from 'stripe';

import { stripeErrorType } from './stripe-client.js';

export type StripeEvent = Stripe.Event;

// Cliente "vazio" só para acessar o verificador; não faz chamadas de rede.
const verifier = new Stripe('sk_test_signature_verifier_only');

export class StripeWebhookSignatureError extends Error {
  constructor() {
    super('Assinatura do webhook Stripe inválida.');
    this.name = 'StripeWebhookSignatureError';
  }
}

export function verifyStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string,
  webhookSecret: string,
): StripeEvent {
  try {
    return verifier.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
  } catch (error) {
    if (stripeErrorType(error) === 'StripeSignatureVerificationError') {
      throw new StripeWebhookSignatureError();
    }
    throw error;
  }
}

/** Gera um header de assinatura válido — usado em testes. */
export function signStripeWebhookPayload(payload: string, webhookSecret: string): string {
  return verifier.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
}

/** Eventos de assinatura (Story 15.6, D5) — nenhum evento de disputa. */
export const STRIPE_SUBSCRIPTION_WEBHOOK_EVENTS = [
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.deleted',
] as const;

/** Eventos que o owner cadastra no painel Stripe (spec D5: avulsa + assinatura). */
export const STRIPE_WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  ...STRIPE_SUBSCRIPTION_WEBHOOK_EVENTS,
] as const;

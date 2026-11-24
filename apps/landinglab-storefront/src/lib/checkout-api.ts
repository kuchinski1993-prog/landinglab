// Chamadas server-side do storefront à API do checkout Stripe (Story 15.3).
// O browser fala só com o próprio domínio da landing (proxy em
// /api/ll-checkout); daqui a chamada segue servidor→servidor, sem CORS.
//
// Rate-limit da API por cliente (QA 15.3 PERF-002 / 15.4 SEC-001): toda
// chamada leva o IP do cliente; com LANDINGLAB_PROXY_SECRET (mesmo valor na
// API) ele vai assinado em x-ll-client-ip (a API confia só em 1 hop de proxy,
// então sem assinatura enxerga o IP de saída da Vercel).
import { signedClientIpHeaders } from './client-ip-signature';

export function apiBase(): string {
  return process.env['NEXT_PUBLIC_API_URL']?.replace(/\/$/, '') ?? 'https://t.authenlondon.com';
}

export interface CheckoutItem {
  title: string;
  quantity: number;
  unitLabel: string | null;
  priceMinor: number;
  compareAtMinor: number | null;
  image: string | null;
}

export interface CheckoutBrand {
  name: string | null;
  logoUrl: string | null;
  logoHeight: number;
  logoAlign: 'left' | 'center' | 'right';
}

export interface ShippingOptionView {
  method: 'free' | 'express';
  label: string;
  amountMinor: number;
  minDays: number;
  maxDays: number;
}

export interface QuoteView {
  subtotalMinor: number;
  shippingMinor: number;
  totalMinor: number;
  shippingMethod: 'free' | 'express';
}

export interface CheckoutView {
  status: 'open' | 'paid' | 'expired';
  locale: string;
  currency: string;
  items: CheckoutItem[];
  countries: string[];
  shippingOptions: ShippingOptionView[];
  quote: QuoteView;
  orderNumber: string | null;
  metaEventId: string;
  pixelId: string | null;
  /** Story 15.4: landing do checkout — resolve o mercado das políticas do rodapé (AC13). */
  landingPageId?: string | null;
  /** Marca da landing para o header (Story 15.7). Mantido por compatibilidade. */
  brandName?: string | null;
  /** Story 15.7: marca do header com logo (altura/alinhamento já validados pela API). */
  brand?: CheckoutBrand | null;
  /** Story 15.6: sessão de assinatura (null/ausente = compra avulsa da 15.3). */
  billing?: BillingView | null;
}

export interface BillingView {
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount: number;
  /** Valor recorrente (com desconto) de todas as faturas — o servidor decide. */
  unitAmountMinor: number;
  discountPercent: number;
}

export async function callCheckoutApi(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; clientIp?: string | null; userAgent?: string | null },
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.clientIp) {
    headers['x-forwarded-for'] = init.clientIp;
    Object.assign(headers, signedClientIpHeaders(init.clientIp));
  }
  if (init.userAgent) headers['user-agent'] = init.userAgent;
  return fetch(`${apiBase()}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
  });
}

/** IP/UA do cliente da requisição original (páginas server-side). */
export interface ClientContext {
  clientIp: string | null;
  userAgent: string | null;
}

export async function fetchCheckoutView(token: string, ctx?: ClientContext): Promise<CheckoutView | null> {
  const res = await callCheckoutApi(`/stripe-checkout/${encodeURIComponent(token)}`, {
    method: 'GET',
    clientIp: ctx?.clientIp ?? null,
    userAgent: ctx?.userAgent ?? null,
  });
  if (!res.ok) return null;
  return (await res.json()) as CheckoutView;
}

/** Retorno do pagamento: a API confere o PaymentIntent e cria o pedido se pago. */
export async function confirmCheckout(token: string, ctx?: ClientContext): Promise<Response> {
  return callCheckoutApi(`/stripe-checkout/${encodeURIComponent(token)}/confirm`, {
    method: 'POST',
    body: {},
    clientIp: ctx?.clientIp ?? null,
    userAgent: ctx?.userAgent ?? null,
  });
}

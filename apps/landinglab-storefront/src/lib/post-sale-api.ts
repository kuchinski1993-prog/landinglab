// Pós-venda público do storefront (Story 15.4): rastreio e políticas.
// Mesmo padrão do checkout: o browser fala só com o domínio da landing e o
// servidor do storefront repassa à API (servidor→servidor, sem CORS).
//
// Contratos (Dev Notes "Contratos API 15.4"):
//   POST /landing-orders/lookup                       { orderNumber, email }
//   GET  /landing-policies?host=&landingPageId=       { locale, policies: [{ slug, title }] }
//   GET  /landing-policies/:slug?host=&landingPageId= { slug, title, locale, html } | 404
import { isPolicySlug, sanitizePolicyHtml, type PolicySlug } from '@blackshop/payments/policies';

import { callCheckoutApi } from './checkout-api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LOOKUP_NOT_FOUND = { error: 'Order not found.', code: 'not_found' } as const;

export type PublicEventType =
  | 'paid'
  | 'preparing'
  | 'shipped'
  | 'refunded'
  // Story 15.6
  | 'subscription_started'
  | 'subscription_renewed'
  | 'subscription_canceled';

export interface PublicOrderEvent {
  type: PublicEventType;
  at: string;
  details: {
    carrier?: string | null;
    code?: string | null;
    url?: string | null;
    amountMinor?: number | null;
    currency?: string | null;
    full?: boolean;
  };
}

export interface PublicOrderView {
  orderNumber: string;
  status: string;
  locale: string;
  placedAt: string;
  tracking: { code: string; carrier: string; url: string | null } | null;
  events: PublicOrderEvent[];
  /** Story 15.6 — pedido de assinatura (selo + link assinado de gestão). */
  subscription?: PublicSubscriptionView | null;
}

export interface PublicSubscriptionView {
  status: string;
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount: number;
  amountMinor: number;
  currency: string;
  /** Caminho relativo assinado (/assinatura/gerir?t=…); null = sem gestão. */
  managePath: string | null;
}

export interface PolicyLink {
  slug: PolicySlug;
  title: string;
}

export interface PolicyPageView {
  slug: PolicySlug;
  title: string;
  locale: string;
  html: string;
}

export interface RequestContext {
  host: string;
  clientIp: string | null;
  userAgent: string | null;
}

/** Host da requisição sem porta nem `www.` (mesma normalização do middleware). */
export function normalizeHost(raw: string | null | undefined): string {
  return (raw ?? '')
    .split(',')[0]!
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

/** Lê host/IP/UA do request original (Vercel: x-forwarded-*). */
export function requestContext(headers: Pick<Headers, 'get'>): RequestContext {
  return {
    host: normalizeHost(headers.get('x-forwarded-host') ?? headers.get('host')),
    clientIp: headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    userAgent: headers.get('user-agent'),
  };
}

export function validLandingPageId(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined;
}

/** Normaliza a entrada do formulário. `null` = inválida (vira o mesmo "não encontrado"). */
export function normalizeLookupInput(body: unknown): { orderNumber: string; email: string } | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const orderNumber =
    typeof raw['orderNumber'] === 'string' ? raw['orderNumber'].trim().replace(/^#+\s*/, '') : '';
  const email = typeof raw['email'] === 'string' ? raw['email'].trim() : '';
  if (!orderNumber || orderNumber.length > 40 || !email || email.length > 254) return null;
  return { orderNumber, email };
}

function policiesQuery(host: string, landingPageId?: string | null): string {
  const params = new URLSearchParams({ host });
  const lp = validLandingPageId(landingPageId);
  if (lp) params.set('landingPageId', lp);
  return params.toString();
}

/**
 * Políticas publicadas do mercado da landing servida no host. Também é a
 * forma pública de descobrir o idioma do mercado pelo host (`locale`).
 * Falha da API = lista vazia (o rodapé some, a página continua funcionando).
 */
export async function fetchPublishedPolicies(
  ctx: RequestContext,
  landingPageId?: string | null,
): Promise<{ locale: string | null; policies: PolicyLink[] }> {
  if (!ctx.host) return { locale: null, policies: [] };
  try {
    const res = await callCheckoutApi(`/landing-policies?${policiesQuery(ctx.host, landingPageId)}`, {
      method: 'GET',
      clientIp: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    if (!res.ok) return { locale: null, policies: [] };
    const data = (await res.json()) as { locale?: unknown; policies?: unknown };
    const policies = Array.isArray(data.policies)
      ? (data.policies as Array<{ slug?: unknown; title?: unknown }>)
          .filter((p): p is PolicyLink => isPolicySlug(p.slug) && typeof p.title === 'string' && p.title !== '')
          .map((p) => ({ slug: p.slug, title: p.title }))
      : [];
    return { locale: typeof data.locale === 'string' ? data.locale : null, policies };
  } catch {
    return { locale: null, policies: [] };
  }
}

/** Política publicada pronta para servir; `null` = 404 (draft, slug/host desconhecido, pendência). */
export async function fetchPolicyPage(
  slug: string,
  ctx: RequestContext,
  landingPageId?: string | null,
): Promise<PolicyPageView | null> {
  if (!isPolicySlug(slug) || !ctx.host) return null;
  try {
    const res = await callCheckoutApi(
      `/landing-policies/${encodeURIComponent(slug)}?${policiesQuery(ctx.host, landingPageId)}`,
      { method: 'GET', clientIp: ctx.clientIp, userAgent: ctx.userAgent },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<PolicyPageView>;
    if (typeof data.html !== 'string' || typeof data.title !== 'string') return null;
    return {
      slug,
      title: data.title,
      locale: typeof data.locale === 'string' ? data.locale : 'en',
      // A API já sanitiza; repetir aqui é defesa em profundidade (idempotente).
      html: sanitizePolicyHtml(data.html),
    };
  } catch {
    return null;
  }
}

/** Repasse do formulário de /rastreio para a API (IP do cliente para o rate-limit). */
export async function lookupOrder(
  input: { orderNumber: string; email: string },
  ctx: Pick<RequestContext, 'clientIp' | 'userAgent'>,
): Promise<Response> {
  return callCheckoutApi('/landing-orders/lookup', {
    method: 'POST',
    body: input,
    clientIp: ctx.clientIp,
    userAgent: ctx.userAgent,
  });
}

// ─── Story 15.6 — gestão da assinatura ──────────────────────────────────────
// Contratos (Dev Notes "Contratos API 15.6"):
//   GET  /stripe-checkout/subscription/manage?t=<token> → { url } | 404 invalid_link | 503 portal_unavailable
//   POST /stripe-checkout/subscription/link { orderNumber, email } → { path } | 404

export type ManageOutcome = { kind: 'portal'; url: string } | { kind: 'invalid' } | { kind: 'unavailable' };

/** Só aceita URL https da Stripe para o redirect (nunca redireciona para outro lugar). */
export function isStripePortalUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'billing.stripe.com' || url.hostname.endsWith('.stripe.com'));
  } catch {
    return false;
  }
}

/** Troca o token assinado por uma sessão do Customer Portal (na conta de origem, pela API). */
export async function openSubscriptionPortal(
  token: string | null | undefined,
  ctx: Pick<RequestContext, 'clientIp' | 'userAgent'>,
): Promise<ManageOutcome> {
  if (!token || token.length > 512) return { kind: 'invalid' };
  try {
    const res = await callCheckoutApi(`/stripe-checkout/subscription/manage?t=${encodeURIComponent(token)}`, {
      method: 'GET',
      clientIp: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    if (res.status === 404) return { kind: 'invalid' };
    if (!res.ok) return { kind: 'unavailable' };
    const data = (await res.json()) as { url?: unknown };
    return isStripePortalUrl(data.url) ? { kind: 'portal', url: data.url } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** /assinatura → novo link (nº do pedido + e-mail). Repasse para a API com IP do cliente. */
export async function requestManageLink(
  input: { orderNumber: string; email: string },
  ctx: Pick<RequestContext, 'clientIp' | 'userAgent'>,
): Promise<Response> {
  return callCheckoutApi('/stripe-checkout/subscription/link', {
    method: 'POST',
    body: input,
    clientIp: ctx.clientIp,
    userAgent: ctx.userAgent,
  });
}

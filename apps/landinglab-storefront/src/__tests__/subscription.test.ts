// Story 15.6 — storefront: /assinatura/gerir (Portal), proxy do link,
// middleware, /rastreio com assinatura, resumo do checkout e runtime do CTA.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST as LINK } from '../app/api/ll-subscription-link/route';
import { GET as MANAGE } from '../app/assinatura/gerir/route';
import { isStripePortalUrl, type PublicOrderView } from '../lib/post-sale-api';
import { trackingStrings } from '../lib/post-sale-i18n';
import { buildTrackingDisplay, safeManagePath } from '../lib/tracking-view';
import { isPostSalePath, middleware } from '../middleware';

afterEach(() => {
  vi.unstubAllGlobals();
});

function upstream(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('GET /assinatura/gerir', () => {
  it('token válido → 302 para o Customer Portal (URL da Stripe), IP repassado', async () => {
    const fn = upstream(200, { url: 'https://billing.stripe.com/p/session/test_123' });
    const res = await MANAGE(
      new Request('https://shop.example.it/assinatura/gerir?t=abc.def', { headers: { 'x-forwarded-for': '198.51.100.9' } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://billing.stripe.com/p/session/test_123');
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/stripe-checkout\/subscription\/manage\?t=abc\.def$/);
    expect((init.headers as Record<string, string>)['x-forwarded-for']).toBe('198.51.100.9');
  });

  it('inválido/expirado → /assinatura?e=invalid; sem token não chama a API', async () => {
    upstream(404, { error: 'Link non valido o scaduto.', code: 'invalid_link' });
    const res = await MANAGE(new Request('https://shop.example.it/assinatura/gerir?t=bad'));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).pathname + new URL(res.headers.get('location')!).search).toBe('/assinatura?e=invalid');
    const spy = upstream(200, {});
    const none = await MANAGE(new Request('https://shop.example.it/assinatura/gerir'));
    expect(spy).not.toHaveBeenCalled();
    expect(none.headers.get('location')).toContain('e=invalid');
  });

  it('Portal indisponível ou URL não-Stripe → /assinatura?e=unavailable (nunca redireciona para fora da Stripe)', async () => {
    upstream(503, { code: 'portal_unavailable' });
    expect((await MANAGE(new Request('https://shop.example.it/assinatura/gerir?t=x'))).headers.get('location')).toContain('e=unavailable');
    upstream(200, { url: 'https://evil.example.com/phish' });
    expect((await MANAGE(new Request('https://shop.example.it/assinatura/gerir?t=x'))).headers.get('location')).toContain('e=unavailable');
    expect(isStripePortalUrl('http://billing.stripe.com/x')).toBe(false);
    expect(isStripePortalUrl('https://billing.stripe.com.evil.io/x')).toBe(false);
  });
});

describe('POST /api/ll-subscription-link', () => {
  const req = (body: unknown) =>
    new Request('https://shop.example.it/api/ll-subscription-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('devolve só o caminho relativo assinado', async () => {
    const fn = upstream(200, { path: '/assinatura/gerir?t=abc.def' });
    const res = await LINK(req({ orderNumber: '#IT-10001', email: 'a@b.it' }));
    expect(await res.json()).toEqual({ path: '/assinatura/gerir?t=abc.def' });
    expect(JSON.parse((fn.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ orderNumber: 'IT-10001', email: 'a@b.it' });
  });

  it('não-enumeração: 404 idêntico; caminho estranho da API → 502', async () => {
    upstream(404, { code: 'not_found' });
    const a = await LINK(req({ orderNumber: 'IT-1', email: 'x@b.it' }));
    const b = await LINK(req({}));
    expect(a.status).toBe(404);
    expect(await a.text()).toBe(await b.text());
    upstream(200, { path: 'https://evil.example.com' });
    expect((await LINK(req({ orderNumber: 'IT-1', email: 'a@b.it' }))).status).toBe(502);
  });
});

describe('middleware: /assinatura fora do rewrite de landing', () => {
  const rewriteOf = (path: string) =>
    middleware(new NextRequest(`https://shop.example.it${path}`, { headers: { host: 'shop.example.it' } })).headers.get(
      'x-middleware-rewrite',
    );
  it('não reescreve /assinatura e /assinatura/gerir; slug parecido continua landing', () => {
    expect(rewriteOf('/assinatura')).toBeNull();
    expect(rewriteOf('/assinatura/gerir')).toBeNull();
    expect(isPostSalePath('/assinatura')).toBe(true);
    expect(isPostSalePath('/assinaturas-promo')).toBe(false);
    expect(new URL(rewriteOf('/assinaturas-promo')!).pathname).toBe('/landing/shop.example.it/assinaturas-promo');
  });
});

describe('/rastreio com assinatura', () => {
  const base: PublicOrderView = {
    orderNumber: 'IT-10002',
    status: 'paid',
    locale: 'it',
    placedAt: '2026-10-01T10:00:00.000Z',
    tracking: null,
    events: [
      { type: 'paid', at: '2026-10-01T10:00:00.000Z', details: {} },
      { type: 'subscription_renewed', at: '2026-10-01T10:00:01.000Z', details: {} },
    ],
    subscription: {
      status: 'active',
      interval: 'month',
      intervalCount: 1,
      amountMinor: 2392,
      currency: 'EUR',
      managePath: '/assinatura/gerir?t=abc.def',
    },
  };

  it('mostra recorrência, evento de renovação e link de gestão (sem data futura)', () => {
    const view = buildTrackingDisplay(base, trackingStrings('it'), 'it-IT');
    expect(view.subscription).toEqual({ recurring: expect.stringMatching(/23,92.*ogni mese/), managePath: '/assinatura/gerir?t=abc.def', canceled: false });
    expect(view.timeline.map((r) => r.label)).toContain('Abbonamento rinnovato — nuovo ordine');
  });

  it('cancelada: sem link de gestão; link fora do padrão é descartado', () => {
    const canceled = buildTrackingDisplay(
      { ...base, subscription: { ...base.subscription!, status: 'canceled' } },
      trackingStrings('it'),
      'it',
    );
    expect(canceled.subscription?.managePath).toBeNull();
    expect(safeManagePath('https://evil.example.com/assinatura/gerir?t=x')).toBeNull();
    expect(safeManagePath('/assinatura/gerir?t=a"onload')).toBeNull();
    expect(buildTrackingDisplay({ ...base, subscription: null }, trackingStrings('it'), 'it').subscription).toBeNull();
  });
});

describe('runtime do CTA e checkout (código-fonte)', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf-8');

  it('CTA Stripe envia subscribe:true só com o checkbox do widget marcado (sem preço/intervalo)', () => {
    const src = read('../app/landing/[host]/[[...slug]]/route.ts');
    expect(src).toContain("document.querySelector('[data-landinglab-subs-widget] [data-landinglab-subs-check]')");
    expect(src).toContain('if(wantsSubscription()) body.subscribe = true;');
    // Caminho Shopify (selling_plan) intacto.
    expect(src).toContain('if(planId) body.cartItems[0].sellingPlanId = planId;');
  });

  it('checkout: Elements deferred só para assinatura; avulsa continua com clientSecret do PaymentIntent', () => {
    const src = read('../app/checkout/[token]/CheckoutClient.tsx');
    expect(src).toContain("mode: 'subscription'");
    expect(src).toContain("intent.mode === 'subscription'");
    expect(src).toContain("post<SubscribeResponse>(token, 'subscribe'");
    expect(src).toContain('clientSecret: intent.clientSecret');
    expect(read('../app/api/ll-checkout/[token]/[action]/route.ts')).toContain("'subscribe'");
  });
});

import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '../app/api/ll-tracking/route';
import { isPostSalePath, middleware } from '../middleware';

afterEach(() => {
  vi.unstubAllGlobals();
});

function trackingRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://shop.example.it/api/ll-tracking', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function upstream(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const NOT_FOUND = { error: 'Order not found.', code: 'not_found' };

describe('POST /api/ll-tracking (proxy do /rastreio)', () => {
  it('repassa à API /landing-orders/lookup com IP e UA do cliente', async () => {
    const order = { orderNumber: 'LL-1001', status: 'paid', locale: 'it', placedAt: 'x', tracking: null, events: [] };
    const fn = upstream(200, { order });
    const res = await POST(
      trackingRequest(
        { orderNumber: '#LL-1001', email: 'Cliente@Example.it' },
        { 'x-forwarded-for': '198.51.100.9, 10.0.0.1', 'user-agent': 'Mozilla' },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ order });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/landing-orders\/lookup$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ orderNumber: 'LL-1001', email: 'Cliente@Example.it' });
    const headers = init.headers as Record<string, string>;
    expect(headers['x-forwarded-for']).toBe('198.51.100.9');
    expect(headers['user-agent']).toBe('Mozilla');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('não-enumeração: inexistente, e-mail errado e entrada inválida devolvem a MESMA resposta', async () => {
    upstream(404, { error: 'Order not found.', code: 'not_found' });
    const wrong = await POST(trackingRequest({ orderNumber: 'LL-1001', email: 'outro@example.it' }));
    const missing = await POST(trackingRequest({ orderNumber: 'LL-9999', email: 'a@example.it' }));
    const fetchSpy = upstream(200, {});
    const empty = await POST(trackingRequest({ orderNumber: '', email: '' }));
    const garbage = await POST(trackingRequest('not json'));
    expect(fetchSpy).not.toHaveBeenCalled();

    const bodies = await Promise.all([wrong, missing, empty, garbage].map((r) => r.text()));
    for (const r of [wrong, missing, empty, garbage]) expect(r.status).toBe(404);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual(NOT_FOUND);
  });

  it('rate-limit da API (429) chega ao cliente', async () => {
    upstream(429, { error: 'Rate limit exceeded' });
    const res = await POST(trackingRequest({ orderNumber: 'LL-1', email: 'a@b.it' }));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('rate_limited');
  });

  it('erro da API ou rede → 502 genérico (sem vazar detalhe)', async () => {
    upstream(500, { error: 'stack trace...' });
    const res = await POST(trackingRequest({ orderNumber: 'LL-1', email: 'a@b.it' }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('stack');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    expect((await POST(trackingRequest({ orderNumber: 'LL-1', email: 'a@b.it' }))).status).toBe(502);
  });
});

describe('middleware: /rastreio e /policies/ fora do rewrite de landing', () => {
  const rewriteOf = (path: string) =>
    middleware(new NextRequest(`https://shop.example.it${path}`, { headers: { host: 'shop.example.it' } })).headers.get(
      'x-middleware-rewrite',
    );

  it.each(['/rastreio', '/rastreio/', '/policies/refund-policy', '/checkout/abc'])('%s não é reescrito', (path) => {
    expect(rewriteOf(path)).toBeNull();
  });

  it.each([
    ['/', '/landing/shop.example.it'],
    ['/oferta1', '/landing/shop.example.it/oferta1'],
    ['/rastreio-promo', '/landing/shop.example.it/rastreio-promo'],
    ['/policiesx', '/landing/shop.example.it/policiesx'],
  ])('landing %s continua reescrita', (path, target) => {
    expect(new URL(rewriteOf(path)!).pathname).toBe(target);
  });

  it('isPostSalePath', () => {
    expect(isPostSalePath('/rastreio')).toBe(true);
    expect(isPostSalePath('/policies/privacy-policy')).toBe(true);
    expect(isPostSalePath('/rastreio2')).toBe(false);
  });
});

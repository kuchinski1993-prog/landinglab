// Regressões de QA nas chamadas servidor→API do storefront:
//   15.3 PERF-002 — páginas server-side repassam o IP do cliente;
//   15.4 SEC-001 — IP do cliente assinado com LANDINGLAB_PROXY_SECRET.
import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { callCheckoutApi, confirmCheckout, fetchCheckoutView } from '../checkout-api';

const SECRET = 's'.repeat(40);
const ctx = { clientIp: '203.0.113.7', userAgent: 'UA' };

function mockFetch(status = 200, body: unknown = { status: 'open' }) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function headersOf(fn: { mock: { calls: unknown[][] } }, i = 0): Record<string, string> {
  return ((fn.mock.calls[i] as unknown as [string, RequestInit])[1].headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('PERF-002 — IP do cliente nas páginas do checkout', () => {
  it('view e confirm levam o IP/UA do cliente (bucket do rate-limit por cliente)', async () => {
    const fn = mockFetch();
    await fetchCheckoutView('tok_abcdefghijklmnopqrstuvwxyz', ctx);
    await confirmCheckout('tok_abcdefghijklmnopqrstuvwxyz', ctx);
    expect(headersOf(fn, 0)).toMatchObject({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'UA' });
    expect(headersOf(fn, 1)).toMatchObject({ 'x-forwarded-for': '203.0.113.7' });
    const [url, init] = fn.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/stripe-checkout\/tok_abcdefghijklmnopqrstuvwxyz\/confirm$/);
    expect(init.method).toBe('POST');
  });
});

describe('SEC-001 — IP do cliente assinado para a API', () => {
  it('com LANDINGLAB_PROXY_SECRET: x-ll-client-ip + HMAC-SHA256', async () => {
    vi.stubEnv('LANDINGLAB_PROXY_SECRET', SECRET);
    const fn = mockFetch();
    await callCheckoutApi('/landing-orders/lookup', { method: 'POST', body: {}, clientIp: '203.0.113.7' });
    const h = headersOf(fn);
    expect(h['x-ll-client-ip']).toBe('203.0.113.7');
    expect(h['x-ll-client-ip-sig']).toBe(createHmac('sha256', SECRET).update('ll-client-ip:203.0.113.7').digest('hex'));
  });

  it('sem segredo (ou curto) não envia cabeçalho assinado; sem IP nada é assinado', async () => {
    vi.stubEnv('LANDINGLAB_PROXY_SECRET', 'curto');
    const fn = mockFetch();
    await callCheckoutApi('/x', { method: 'GET', clientIp: '203.0.113.7' });
    expect(headersOf(fn)['x-ll-client-ip']).toBeUndefined();
    vi.stubEnv('LANDINGLAB_PROXY_SECRET', SECRET);
    await callCheckoutApi('/x', { method: 'GET' });
    expect(headersOf(fn, 1)['x-ll-client-ip']).toBeUndefined();
  });
});

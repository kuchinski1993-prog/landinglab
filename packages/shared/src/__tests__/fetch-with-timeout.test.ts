// Story 0.8 · AC1/AC8 — helper de timeout e Retry-After.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  UpstreamRateLimitedError,
  UpstreamTimeoutError,
  fetchWithTimeout,
  parseRetryAfterMs,
  timeoutFromEnv,
} from '../http/fetch-with-timeout.js';

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  it('segundos', () => {
    expect(parseRetryAfterMs('2', now)).toBe(2000);
    expect(parseRetryAfterMs(' 1.5 ', now)).toBe(1500);
    expect(parseRetryAfterMs('0', now)).toBe(0);
  });
  it('data HTTP', () => {
    expect(parseRetryAfterMs('Sun, 01 Nov 2026 12:00:03 GMT', now)).toBe(3000);
  });
  it('data no passado → 0', () => {
    expect(parseRetryAfterMs('Sun, 01 Nov 2026 11:59:00 GMT', now)).toBe(0);
  });
  it('inválido ou negativo → null', () => {
    expect(parseRetryAfterMs('-1', now)).toBeNull();
    expect(parseRetryAfterMs('abc', now)).toBeNull();
    expect(parseRetryAfterMs('', now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
    expect(parseRetryAfterMs('1e3', now)).toBeNull();
  });
});

describe('timeoutFromEnv', () => {
  it('usa o padrão sem variável ou com valor inválido', () => {
    expect(timeoutFromEnv('X', 15_000, {})).toBe(15_000);
    expect(timeoutFromEnv('X', 15_000, { X: 'abc' })).toBe(15_000);
    expect(timeoutFromEnv('X', 15_000, { X: '-5' })).toBe(15_000);
  });
  it('aceita inteiro positivo', () => expect(timeoutFromEnv('X', 15_000, { X: '3000' })).toBe(3000));
});

// Antes dos testes com servidor real: o undici arma timers internos depois do primeiro
// fetch real, o que poluiria a contagem de timers pendentes.
describe('fetchWithTimeout (timers)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('limpa o timer em sucesso (sem handle pendente)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await fetchWithTimeout('https://x.test', {}, { timeoutMs: 10_000, label: 't', fetchImpl });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limpa o timer em erro de rede e repassa o erro original', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await fetchWithTimeout('https://x.test', {}, { timeoutMs: 10_000, label: 't', fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fetch que ignora o signal ainda respeita o prazo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
    const p = fetchWithTimeout('https://x.test', {}, { timeoutMs: 5_000, label: 'meta-capi', uncertain: true, fetchImpl }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await p;
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('signal externo abortado não vira timeout', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
    const err = await fetchWithTimeout('https://x.test', { signal: ctrl.signal }, { timeoutMs: 5_000, label: 't', fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(UpstreamTimeoutError);
  });
});

// Servidor HTTP fake: rápido, cabeçalho lento, corpo lento.
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/fast') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-test': '1' });
      res.end('{"ok":true}');
    } else if (req.url === '/slow-headers') {
      setTimeout(() => {
        res.writeHead(200);
        res.end('{}');
      }, 2_000);
    } else if (req.url === '/slow-body') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      setTimeout(() => res.end('true}'), 2_000);
    } else if (req.url === '/no-content') {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('fetchWithTimeout (servidor real)', () => {
  it('servidor rápido: devolve status, cabeçalhos e corpo', async () => {
    const res = await fetchWithTimeout(`${base}/fast`, {}, { timeoutMs: 1_000, label: 'teste' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-test')).toBe('1');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('204 sem corpo', async () => {
    const res = await fetchWithTimeout(`${base}/no-content`, {}, { timeoutMs: 1_000, label: 'teste' });
    expect(res.status).toBe(204);
  });

  it('cabeçalho lento → UpstreamTimeoutError (uncertain conforme opção)', async () => {
    const t0 = Date.now();
    const err = await fetchWithTimeout(`${base}/slow-headers`, {}, { timeoutMs: 100, label: 'shopify-admin' }).catch(
      (e: unknown) => e,
    );
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect(err).toMatchObject({ code: 'UPSTREAM_TIMEOUT', label: 'shopify-admin', timeoutMs: 100, uncertain: false });
  });

  it('corpo lento também aborta', async () => {
    const t0 = Date.now();
    const err = await fetchWithTimeout(
      `${base}/slow-body`,
      {},
      { timeoutMs: 150, label: 'shopify-storefront', uncertain: true },
    ).catch((e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect((err as UpstreamTimeoutError).uncertain).toBe(true);
  });

  it('mensagem do erro não contém URL nem segredos', async () => {
    const err = (await fetchWithTimeout(
      `${base}/slow-headers?access_token=SEGREDO123`,
      { headers: { 'X-Shopify-Access-Token': 'shpat_SEGREDO' }, body: 'client_secret=SEGREDO', method: 'POST' },
      { timeoutMs: 50, label: 'shopify-oauth-token' },
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toMatch(/SEGREDO|127\.0\.0\.1|access_token/);
    expect(JSON.stringify(err)).not.toMatch(/SEGREDO/);
  });
});

describe('UpstreamRateLimitedError', () => {
  it('code estável e retryAfterMs', () => {
    const e = new UpstreamRateLimitedError('shopify-admin', 2000, 4);
    expect(e).toMatchObject({ code: 'UPSTREAM_RATE_LIMITED', retryAfterMs: 2000, attempts: 4, label: 'shopify-admin' });
  });
});

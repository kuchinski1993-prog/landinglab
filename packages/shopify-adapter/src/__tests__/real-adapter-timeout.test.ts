// Story 0.8 · AC2/AC4/AC8 — RealShopifyAdapter com Shopify lenta e com 429.
import { UpstreamRateLimitedError, UpstreamTimeoutError } from '@blackshop/shared/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RealShopifyAdapter } from '../real.adapter.js';

const ORIGINAL_FETCH = global.fetch;
const TOKEN = 'shpat_SEGREDO_ADMIN_TOKEN';

type FetchMock = ReturnType<typeof vi.fn<[string, RequestInit?], Promise<Response>>>;

/** "Servidor" que nunca responde, mas aborta quando o signal dispara (como o fetch real). */
function hangingImpl(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

function hangingFetch(): FetchMock {
  return vi.fn<[string, RequestInit?], Promise<Response>>(hangingImpl);
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

describe('RealShopifyAdapter — timeout (AC2)', () => {
  let fetchMock: FetchMock;
  beforeEach(() => {
    fetchMock = hangingFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it('query lenta → UpstreamTimeoutError uncertain=false, retentada até o limite', async () => {
    const adapter = new RealShopifyAdapter(TOKEN, 'loja.myshopify.com', { throttleDelayMs: 1, timeoutMs: 30 });
    const err = (await adapter.getProduct('1').catch((e: unknown) => e)) as UpstreamTimeoutError;
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect(err).toMatchObject({ code: 'UPSTREAM_TIMEOUT', label: 'shopify-admin', uncertain: false, timeoutMs: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 + MAX_RETRIES
    expect(err.message).not.toContain(TOKEN);
  });

  it('query lenta que depois responde → sucesso no retry', async () => {
    fetchMock.mockImplementationOnce(hangingImpl).mockResolvedValueOnce(ok({ product: null }));
    const adapter = new RealShopifyAdapter(TOKEN, 'loja.myshopify.com', { throttleDelayMs: 1, timeoutMs: 30 });
    await expect(adapter.getProduct('1')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('mutation lenta → UpstreamTimeoutError uncertain=true, SEM retry', async () => {
    const adapter = new RealShopifyAdapter(TOKEN, 'loja.myshopify.com', { throttleDelayMs: 1, timeoutMs: 30 });
    const err = (await adapter.deleteProduct('1').catch((e: unknown) => e)) as UpstreamTimeoutError;
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect(err.uncertain).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('RealShopifyAdapter — 429 com Retry-After (AC4)', () => {
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  function adapterWithSleepSpy() {
    const adapter = new RealShopifyAdapter(TOKEN, 'loja.myshopify.com', { throttleDelayMs: 10, timeoutMs: 1_000 });
    const sleeps: number[] = [];
    (adapter as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    return { adapter, sleeps };
  }

  it('espera max(backoff, Retry-After) e conclui', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(ok({ shop: { name: 'Loja' } })) as unknown as typeof fetch;
    const { adapter, sleeps } = adapterWithSleepSpy();
    const res = await adapter.testConnection();
    expect(res.ok).toBe(true);
    expect(sleeps).toEqual([2000, 20]); // Retry-After 2 s > backoff 10 ms; depois backoff 20 ms
  });

  it('Retry-After acima de 60 s é limitado a 60 s', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '600' } }))
      .mockResolvedValueOnce(ok({ shop: { name: 'Loja' } })) as unknown as typeof fetch;
    const { adapter, sleeps } = adapterWithSleepSpy();
    await adapter.testConnection();
    expect(sleeps).toEqual([60_000]);
  });

  it('esgotadas as tentativas → UpstreamRateLimitedError com retryAfterMs (não Error genérico)', async () => {
    global.fetch = vi.fn(
      async () => new Response('throttled', { status: 429, headers: { 'Retry-After': '1' } }),
    ) as unknown as typeof fetch;
    const { adapter } = adapterWithSleepSpy();
    const err = (await adapter.getProduct('1').catch((e: unknown) => e)) as UpstreamRateLimitedError;
    expect(err).toBeInstanceOf(UpstreamRateLimitedError);
    expect(err).toMatchObject({ code: 'UPSTREAM_RATE_LIMITED', retryAfterMs: 1000, attempts: 4 });
    expect(err.message).not.toContain(TOKEN);
  });
});

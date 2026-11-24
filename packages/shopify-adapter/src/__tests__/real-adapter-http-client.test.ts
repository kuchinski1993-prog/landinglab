// Story 18.2 · AC10 — RealShopifyAdapter sobre o cliente compartilhado: limites da 0.8 mantidos e
// mutation nunca repetida em 503 (resultado incerto).
import { UpstreamUnavailableError, isUpstreamUncertain } from '@blackshop/shared/http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RealShopifyAdapter } from '../real.adapter.js';

const ORIGINAL_FETCH = global.fetch;
const TOKEN = 'shpat_SEGREDO_ADMIN_TOKEN';

function adapterWithSleepSpy() {
  const adapter = new RealShopifyAdapter(TOKEN, 'loja.myshopify.com', { throttleDelayMs: 10, timeoutMs: 1_000 });
  const sleeps: number[] = [];
  (adapter as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { adapter, sleeps };
}

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('RealShopifyAdapter — 503 (Story 18.2)', () => {
  it('query com 503 persistente: 4 tentativas, backoff 10/20/40 e a mensagem de sempre', async () => {
    const fetchMock = vi.fn(async () => new Response('fora', { status: 503 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { adapter, sleeps } = adapterWithSleepSpy();
    const err = (await adapter.getProduct('1').catch((e: unknown) => e)) as UpstreamUnavailableError;
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect(err.message).toBe('Shopify Admin API throttled: max retries exceeded (3)');
    expect(err).toMatchObject({ kind: 'transient', attempts: 4, status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([10, 20, 40]);
  });

  it('mutation com 503: uma tentativa, erro incerto (nunca reenviada às cegas)', async () => {
    const fetchMock = vi.fn(async () => new Response('fora', { status: 503 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { adapter, sleeps } = adapterWithSleepSpy();
    const err = (await adapter.deleteProduct('1').catch((e: unknown) => e)) as UpstreamUnavailableError;
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect(isUpstreamUncertain(err)).toBe(true);
    expect(err.message).not.toContain(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('mutation com falha de rede: uma tentativa, erro incerto', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { adapter, sleeps } = adapterWithSleepSpy();
    const err = (await adapter.deleteProduct('1').catch((e: unknown) => e)) as UpstreamUnavailableError;
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect(isUpstreamUncertain(err)).toBe(true);
    expect(err.status).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('mutation com 429 continua sendo repetida (não foi processada)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { productDelete: { deletedProductId: 'gid://shopify/Product/1', userErrors: [] } } }), {
          status: 200,
        }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { adapter, sleeps } = adapterWithSleepSpy();
    await expect(adapter.deleteProduct('1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([10]);
  });

  it('500 (fora da política 429/503 da 0.8) não é repetido: erro HTTP de sempre', async () => {
    const fetchMock = vi.fn(async () => new Response('erro', { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { adapter } = adapterWithSleepSpy();
    await expect(adapter.getProduct('1')).rejects.toThrow(/Shopify Admin API error 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

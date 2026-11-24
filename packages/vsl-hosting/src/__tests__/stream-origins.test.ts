import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

import { ensureVslVideoOrigins } from '../stream-origins.js';

const id = 'a'.repeat(32);
const asset = '123e4567-e89b-42d3-a456-426614174000';
const env = { VSL_STREAM_ACCOUNT_ID: id, VSL_STREAM_API_TOKEN: 'test-token' } as NodeJS.ProcessEnv;

/** sql falso: só aceita SELECT simples; `begin` (transação/lock) faz o teste falhar. */
function fakeSql(rows: () => Array<{ id: string; provider_asset_id: string; status: string }> = () => [{ id: asset, provider_asset_id: id, status: 'ready' }]) {
  const queries: string[] = [];
  const sql = Object.assign(async (strings: TemplateStringsArray) => { queries.push(strings.join('?')); return rows(); }, {
    begin: vi.fn(async () => { throw new Error('ensureVslVideoOrigins must not open a transaction'); }),
  });
  return { sql: sql as unknown as Sql, queries, begin: sql.begin };
}

/** Stream falso com estado: GET devolve a lista atual, POST substitui. */
function remoteStream(initial: string[]) {
  const state = { allowedOrigins: [...initial] };
  const calls: Array<{ method: string; signal: AbortSignal | null | undefined }> = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', signal: init?.signal });
    if (init?.method === 'POST') state.allowedOrigins = (JSON.parse(String(init.body)) as { allowedOrigins: string[] }).allowedOrigins;
    return Response.json({ success: true, result: { uid: id, allowedOrigins: [...state.allowedOrigins] } });
  }) as unknown as typeof fetch;
  return { state, calls, fetcher };
}

describe('VSL Stream origin binding', () => {
  it('preserves existing origins and adds a published host', async () => {
    const { sql } = fakeSql();
    const stream = remoteStream(['preview.example.com']);
    await ensureVslVideoOrigins(sql, asset, ['offer.example.com'], env, stream.fetcher);
    expect(stream.calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
    expect(stream.state.allowedOrigins).toEqual(['preview.example.com', 'offer.example.com']);
  });

  it('rejects unrestricted origin policy', async () => {
    const { sql } = fakeSql();
    const fetcher = async () => Response.json({ success: true, result: { uid: id, allowedOrigins: [] } });
    await expect(ensureVslVideoOrigins(sql, asset, ['offer.example.com'], env, fetcher as typeof fetch)).rejects.toMatchObject({ code: 'video_origins_unrestricted', statusCode: 409 });
  });

  // QA F4 M1: nenhuma transação/lock enquanto o Stream responde, e todo fetch leva AbortSignal.
  it('calls Cloudflare outside any transaction or row lock, always with an abort signal', async () => {
    const { sql, queries, begin } = fakeSql();
    const stream = remoteStream(['preview.example.com']);
    await ensureVslVideoOrigins(sql, asset, ['offer.example.com'], env, stream.fetcher);
    expect(begin).not.toHaveBeenCalled();
    expect(queries.every((query) => !/FOR UPDATE/i.test(query))).toBe(true);
    expect(stream.calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
  });

  it('times out a hung Stream API, retries once and fails with stream_unavailable', async () => {
    const { sql } = fakeSql();
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    await expect(ensureVslVideoOrigins(sql, asset, ['offer.example.com'], env, fetcher, { timeoutMs: 40, retryDelayMs: 5 }))
      .rejects.toMatchObject({ code: 'stream_unavailable', statusCode: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('retries a transient 5xx before succeeding', async () => {
    const { sql } = fakeSql();
    const stream = remoteStream(['preview.example.com', 'offer.example.com']);
    let first = true;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (first) { first = false; return new Response('busy', { status: 503 }); }
      return stream.fetcher(url, init);
    }) as unknown as typeof fetch;
    await ensureVslVideoOrigins(sql, asset, ['offer.example.com'], env, fetcher, { retryDelayMs: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('optimistic check: aborts when the video changed while Stream was being updated', async () => {
    let reads = 0;
    const { sql } = fakeSql(() => [{ id: asset, provider_asset_id: ++reads === 1 ? id : 'b'.repeat(32), status: 'ready' }]);
    const stream = remoteStream(['preview.example.com']);
    await expect(ensureVslVideoOrigins(sql, asset, ['offer.example.com'], env, stream.fetcher)).rejects.toMatchObject({ code: 'video_not_ready', statusCode: 409 });
  });

  it('re-applies when another writer overwrote the list, and serializes concurrent calls for the same video', async () => {
    const { sql } = fakeSql();
    const stream = remoteStream(['preview.example.com']);
    let clobbered = false;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const response = await stream.fetcher(url, init);
      // Simula outra instância gravando a lista antiga logo depois do nosso primeiro POST.
      if (init?.method === 'POST' && !clobbered) { clobbered = true; stream.state.allowedOrigins = ['preview.example.com']; }
      return response;
    }) as unknown as typeof fetch;
    await Promise.all([
      ensureVslVideoOrigins(sql, asset, ['a.example.com'], env, fetcher),
      ensureVslVideoOrigins(sql, asset, ['b.example.com'], env, fetcher),
    ]);
    expect(stream.state.allowedOrigins).toEqual(expect.arrayContaining(['preview.example.com', 'a.example.com', 'b.example.com']));
  });
});

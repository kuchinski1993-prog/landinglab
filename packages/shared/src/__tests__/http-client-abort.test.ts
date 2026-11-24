// Story 18.2 · AC7 — abort externo (arquivo próprio: sem servidor HTTP real, para que nenhum timer
// de socket/keep-alive entre na contagem dos timers simulados).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpstreamError, createHttpClient } from '../http/index.js';

describe('AC7 — abort externo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancela a espera de backoff sem deixar timer pendente', async () => {
    vi.useFakeTimers();
    const fetchImpl = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const c = createHttpClient({ label: 'svc', timeoutMs: 1_000, fetchImpl, retry: { attempts: 3, baseDelayMs: 10_000, jitter: 'none' } });
    const controller = new AbortController();
    const pending = c.request('https://svc.example/x', { signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10); // 1ª tentativa falhou; agora na espera de 10 s
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    const err = (await pending) as Error;
    expect(err.name).toBe('AbortError');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancela a chamada em curso (sem retry) e não deixa timer pendente', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    const c = createHttpClient({ label: 'svc', timeoutMs: 60_000, fetchImpl });
    const controller = new AbortController();
    const pending = c.request('https://svc.example/x', { signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5);
    controller.abort();
    const err = (await pending) as Error;
    expect(err.name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('signal já abortado → nenhuma chamada', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const c = createHttpClient({ label: 'svc', timeoutMs: 1_000, fetchImpl });
    await expect(c.request('https://svc.example/x', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });
});

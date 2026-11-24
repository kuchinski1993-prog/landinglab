// Story 18.10e — cliente Spaceship: quantas vezes cada operação envia.
//
// NENHUM teste aqui chama o Spaceship de verdade (register/renew cobram a
// carteira): `fetch` global é sempre mockado e a chave da API é fictícia,
// definida só dentro do teste. O backoff das leituras roda em relógio falso.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DnsRecord } from '@blackshop/landinglab-domains';

import { ProviderConfigError, ProviderRetryableError } from './errors.js';
import { createSpaceshipClient } from './spaceship.js';

const BASE = 'https://spaceship.dev/api/v1';
const FAKE_KEY = 'test-fake-spaceship-key';
const RECORDS: DnsRecord[] = [{ type: 'A', name: '@', value: '76.76.21.21' }];

type Reply = number | { status: number; body?: unknown } | Error;

function toResponse(reply: Exclude<Reply, Error>): Response {
  const { status, body } = typeof reply === 'number' ? { status: reply, body: undefined } : reply;
  const text =
    body === undefined
      ? status >= 400
        ? `upstream error ${status}`
        : '{}'
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);
  return new Response(text, { status });
}

/** Mocka `fetch` com uma resposta por chamada (a última se repete se faltar). */
function mockFetch(...replies: Reply[]) {
  let i = 0;
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const reply = replies[Math.min(i, replies.length - 1)]!;
    i++;
    if (reply instanceof Error) throw reply;
    return toResponse(reply);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Captura a rejeição sem deixar a promise "unhandled" enquanto o relógio avança. */
function settle<T>(p: Promise<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error: unknown) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
}

async function flush() {
  // deixa as microtasks (fetch mockado, response.text/json) rodarem sem avançar o relógio
  await vi.advanceTimersByTimeAsync(0);
}

const client = () => createSpaceshipClient();

type Op = 'checkAvailability' | 'register' | 'configureDNS' | 'renew';

const ops: Record<Op, () => Promise<unknown>> = {
  checkAvailability: () => client().checkAvailability('exemplo.com'),
  register: () => client().register('exemplo.com', { years: 1 }),
  configureDNS: () => client().configureDNS('exemplo.com', RECORDS),
  renew: () => client().renew('exemplo.com', { years: 1 }),
};

const okBody = {
  checkAvailability: { status: 200, body: { available: true, price: 9.99 } },
  register: { status: 200, body: { orderId: 'ord-1' } },
  configureDNS: { status: 200, body: {} },
  renew: { status: 200, body: { orderId: 'ren-1', cost: 12 } },
} as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('LANDINGLAB_SPACESHIP_API_KEY', FAKE_KEY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── Contrato de sucesso ────────────────────────────────────────────────────

describe('contrato de sucesso', () => {
  it('register envia POST /domains/register com a chave e devolve orderId', async () => {
    const f = mockFetch({ status: 200, body: { orderId: 'ord-42' } });
    await expect(ops.register()).resolves.toEqual({ orderId: 'ord-42' });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/domains/register`);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({ domain: 'exemplo.com', years: 1 });
  });

  it('register usa `id` quando não há orderId', async () => {
    mockFetch({ status: 200, body: { id: 'id-7' } });
    await expect(ops.register()).resolves.toEqual({ orderId: 'id-7' });
  });

  it('register sem id devolve unknown-<timestamp>', async () => {
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    mockFetch({ status: 200, body: {} });
    await expect(ops.register()).resolves.toEqual({
      orderId: `unknown-${new Date('2026-11-03T12:00:00Z').getTime()}`,
    });
  });

  it('renew devolve orderId e cost (ou price como fallback)', async () => {
    const f = mockFetch({ status: 200, body: { orderId: 'ren-9', cost: 15 } });
    await expect(ops.renew()).resolves.toEqual({ orderId: 'ren-9', cost: 15 });
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/domains/exemplo.com/renew`);
    expect(f.mock.calls[0]![1]?.method).toBe('POST');

    mockFetch({ status: 200, body: { id: 'ren-10', price: 11 } });
    await expect(ops.renew()).resolves.toEqual({ orderId: 'ren-10', cost: 11 });
  });

  it('checkAvailability (GET) e configureDNS (PUT) usam o método e a URL de hoje', async () => {
    const f = mockFetch(okBody.checkAvailability);
    await expect(ops.checkAvailability()).resolves.toEqual({ available: true, price: 9.99 });
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/domains/check?domain=exemplo.com`);
    expect(f.mock.calls[0]![1]?.method).toBe('GET');

    const g = mockFetch(okBody.configureDNS);
    await expect(ops.configureDNS()).resolves.toBeUndefined();
    expect(g.mock.calls[0]![0]).toBe(`${BASE}/dns/exemplo.com/records`);
    expect(g.mock.calls[0]![1]?.method).toBe('PUT');
  });
});

// ─── register/renew nunca reenviam o POST que cobra (AC2/AC3) ───────────────

const chargeCases = [
  ['register', `${BASE}/domains/register`, '/domains/register', [500, 502, 503, 429]],
  ['renew', `${BASE}/domains/exemplo.com/renew`, '/domains/exemplo.com/renew', [502, 503, 429]],
] as const;

describe.each(chargeCases)('%s nunca reenvia', (op, url, path, statuses) => {
  it.each(statuses)(
    '%i → exatamente 1 POST e rejeição imediata com a mensagem de hoje',
    async (status) => {
      const body = `x`.repeat(250);
      const f = mockFetch({ status, body }, okBody[op]);
      const s = settle(ops[op]());
      await flush(); // sem avançar o relógio: o erro tem de vir na hora
      expect(s.done).toBe(true);
      expect(f).toHaveBeenCalledTimes(1);
      expect(f.mock.calls[0]![0]).toBe(url);
      expect(f.mock.calls[0]![1]?.method).toBe('POST');
      const err = s.error as ProviderRetryableError;
      expect(err).toBeInstanceOf(ProviderRetryableError);
      expect(err.httpStatus).toBe(status);
      expect(err.provider).toBe('spaceship');
      expect(err.message).toBe(`Spaceship POST ${path} failed with ${status}: ${'x'.repeat(200)}`);

      // nem depois de muito tempo sai um 2º envio
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f).toHaveBeenCalledTimes(1);
    },
  );
});

// ─── Leituras e DNS repetem (AC4) ───────────────────────────────────────────

describe.each(['checkAvailability', 'configureDNS'] as const)(
  '%s repete em 429/5xx (leitura / PUT idempotente)',
  (op) => {
    it('503, 503, 200 → 3 chamadas (esperas de 500 ms e 1000 ms) e sucesso', async () => {
      const f = mockFetch(503, 503, okBody[op]);
      const s = settle(ops[op]());
      await flush();
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(f).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(f).toHaveBeenCalledTimes(3);
      expect(s.done).toBe(true);
      expect(s.error).toBeUndefined();
    });

    it('429, 200 → 2 chamadas e sucesso', async () => {
      const f = mockFetch(429, okBody[op]);
      const s = settle(ops[op]());
      await vi.advanceTimersByTimeAsync(500);
      expect(f).toHaveBeenCalledTimes(2);
      expect(s.done).toBe(true);
      expect(s.error).toBeUndefined();
    });

    it('503, 503, 502 → 3 chamadas e lança com o status da última resposta', async () => {
      const f = mockFetch(503, 503, 502);
      const s = settle(ops[op]());
      await vi.advanceTimersByTimeAsync(1500);
      expect(f).toHaveBeenCalledTimes(3);
      expect(s.error).toBeInstanceOf(ProviderRetryableError);
      expect((s.error as ProviderRetryableError).httpStatus).toBe(502);
      expect((s.error as ProviderRetryableError).provider).toBe('spaceship');
    });

    it.each([404, 422])('%i → 1 chamada e erro', async (status) => {
      const f = mockFetch(status);
      const s = settle(ops[op]());
      await vi.advanceTimersByTimeAsync(5000);
      expect(f).toHaveBeenCalledTimes(1);
      expect(s.error).toBeInstanceOf(ProviderRetryableError);
      expect((s.error as ProviderRetryableError).httpStatus).toBe(status);
    });
  },
);

// ─── 4xx ≠ 429 nunca repete (todas as operações) ────────────────────────────

describe.each(['register', 'renew'] as const)('%s com 4xx ≠ 429', (op) => {
  it.each([400, 404, 422])('%i → 1 chamada e erro', async (status) => {
    const f = mockFetch(status);
    const s = settle(ops[op]());
    await vi.advanceTimersByTimeAsync(5000);
    expect(f).toHaveBeenCalledTimes(1);
    expect(s.error).toBeInstanceOf(ProviderRetryableError);
    expect((s.error as ProviderRetryableError).httpStatus).toBe(status);
  });
});

// ─── Modo de falha: rede / timeout (AC5, S6) ────────────────────────────────

describe.each(['checkAvailability', 'register', 'configureDNS', 'renew'] as const)(
  '%s com fetch que rejeita',
  (op) => {
    it.each([
      ['TypeError', () => new TypeError('fetch failed')],
      ['AbortError', () => Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ])('%s → 1 chamada e o erro original propaga', async (_name, makeErr) => {
      const err = makeErr();
      const f = mockFetch(err);
      const s = settle(ops[op]());
      await vi.advanceTimersByTimeAsync(5000);
      expect(f).toHaveBeenCalledTimes(1);
      expect(s.error).toBe(err);
    });
  },
);

describe.each(['checkAvailability', 'register', 'configureDNS', 'renew'] as const)(
  '%s quando o Spaceship não responde em 15 s',
  (op) => {
    it('o timeout aborta, 1 chamada e o AbortError propaga', async () => {
      const f = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      );
      vi.stubGlobal('fetch', f);
      const s = settle(ops[op]());
      await vi.advanceTimersByTimeAsync(14_999);
      expect(s.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.done).toBe(true);
      expect((s.error as Error).name).toBe('AbortError');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f).toHaveBeenCalledTimes(1);
    });
  },
);

// ─── Modo de falha: chave ausente (AC6) ─────────────────────────────────────

describe.each(['checkAvailability', 'register', 'configureDNS', 'renew'] as const)(
  '%s sem LANDINGLAB_SPACESHIP_API_KEY',
  (op) => {
    it('lança ProviderConfigError antes de qualquer fetch', async () => {
      vi.stubEnv('LANDINGLAB_SPACESHIP_API_KEY', '');
      const f = mockFetch(okBody[op]);
      await expect(ops[op]()).rejects.toBeInstanceOf(ProviderConfigError);
      expect(f).not.toHaveBeenCalled();
    });
  },
);

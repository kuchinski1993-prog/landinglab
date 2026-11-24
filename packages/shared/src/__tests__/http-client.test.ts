// Story 18.2 · AC1–AC7 — cliente HTTP com servidor real (lento, 429, 5xx, reset, 4xx),
// relógio simulado (sleep/now injetados) e `random` injetado para o jitter.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as http from '../http/index.js';
import {
  UpstreamError,
  UpstreamRateLimitedError,
  UpstreamRejectedError,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
  createHttpClient,
  isUpstreamUncertain,
  type CreateHttpClientOptions,
} from '../http/index.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
const hits = new Map<string, number>();
let handler: Handler = (_req, res) => res.end('ok');

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections?.();
  server.close();
});
beforeEach(() => hits.clear());

/** Relógio simulado: `sleep` não espera de verdade, só avança o `now`. */
function simulatedClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function client(extra: Partial<CreateHttpClientOptions> = {}) {
  const clock = simulatedClock();
  const c = createHttpClient({ label: 'servico-x', timeoutMs: 1_000, sleep: clock.sleep, now: clock.now, random: () => 0.5, ...extra });
  return { c, clock };
}

describe('AC1 — prazo obrigatório e compatibilidade da 0.8', () => {
  it('sem timeoutMs não compila e lança em tempo de execução', () => {
    // @ts-expect-error timeoutMs é obrigatório no tipo
    expect(() => createHttpClient({ label: 'svc' })).toThrow(/svc.*timeoutMs é obrigatório.*timeoutMs is required/);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createHttpClient({ label: 'svc', timeoutMs: bad }), String(bad)).toThrow(TypeError);
    }
    expect(() => createHttpClient({ label: 'svc', timeoutMs: 10, retry: { attempts: 0 } })).toThrow(TypeError);
  });

  it('exports da 0.8 seguem disponíveis com os mesmos nomes', () => {
    for (const name of [
      'fetchWithTimeout',
      'parseRetryAfterMs',
      'timeoutFromEnv',
      'UpstreamTimeoutError',
      'UpstreamRateLimitedError',
      'isUpstreamTimeoutError',
      'isUpstreamRateLimitedError',
    ]) {
      expect(typeof (http as Record<string, unknown>)[name], name).toBe('function');
    }
    const t = new UpstreamTimeoutError('svc', 10, true);
    expect(t).toMatchObject({ code: 'UPSTREAM_TIMEOUT', statusCode: 504, uncertain: true, kind: 'uncertain', attempts: 1 });
    expect(t.message).toBe('svc: sem resposta em 10 ms (resultado incerto: a operação pode ter sido processada)');
    const r = new UpstreamRateLimitedError('svc', 2000, 4);
    expect(r).toMatchObject({ code: 'UPSTREAM_RATE_LIMITED', statusCode: 503, kind: 'transient', attempts: 4 });
    expect(r.message).toBe('svc: limite de requisições (429) após 4 tentativa(s); Retry-After 2000 ms');
  });

  it('o prazo cobre o corpo lento', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write('{"parcial":');
    };
    const { c } = client({ timeoutMs: 80, retry: { attempts: 1 } });
    await expect(c.request(`${base}/slow-body`)).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });
});

describe('AC2 — timeout depois do envio (não idempotente)', () => {
  it('POST sem Idempotency-Key estoura o prazo → 1 tentativa, uncertain', async () => {
    handler = () => undefined; // nunca responde
    const { c } = client({ timeoutMs: 60 });
    const err = (await c.request(`${base}/slow-post`, { method: 'POST', body: '{}' }).catch((e: unknown) => e)) as UpstreamTimeoutError;
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect(err).toMatchObject({ kind: 'uncertain', uncertain: true, attempts: 1, label: 'servico-x' });
    expect(isUpstreamUncertain(err)).toBe(true);
    expect(hits.get('/slow-post')).toBe(1);
  });

  it('POST com Idempotency-Key ou idempotent:true é repetido (timeout transitório)', async () => {
    handler = () => undefined;
    const { c } = client({ timeoutMs: 40 });
    const a = (await c
      .request(`${base}/slow-key`, { method: 'POST', headers: { 'Idempotency-Key': 'k1' } })
      .catch((e: unknown) => e)) as UpstreamTimeoutError;
    expect(a).toMatchObject({ kind: 'transient', uncertain: false, attempts: 3 });
    expect(hits.get('/slow-key')).toBe(3);
    const b = (await c.request(`${base}/slow-decl`, { method: 'POST' }, { idempotent: true }).catch((e: unknown) => e)) as UpstreamTimeoutError;
    expect(b).toMatchObject({ kind: 'transient', attempts: 3 });
    expect(hits.get('/slow-decl')).toBe(3);
  });
});

describe('AC3 — 429', () => {
  it('Retry-After: 2 → espera ≥ 2 s (relógio simulado), repete e conclui', async () => {
    handler = (_req, res) => {
      if ((hits.get('/rl') ?? 0) === 1) {
        res.writeHead(429, { 'Retry-After': '2' });
        res.end();
        return;
      }
      res.end('ok');
    };
    const { c, clock } = client();
    const { response, attempts } = await c.request(`${base}/rl`);
    expect(await response.text()).toBe('ok');
    expect(attempts).toBe(2);
    expect(clock.sleeps).toEqual([2000]);
  });

  it('Retry-After acima de maxRetryAfterMs é limitado ao teto', async () => {
    handler = (_req, res) => {
      if ((hits.get('/rl-cap') ?? 0) === 1) {
        res.writeHead(429, { 'Retry-After': '600' });
        res.end();
        return;
      }
      res.end('ok');
    };
    const { c, clock } = client({ retry: { maxRetryAfterMs: 5_000, maxTotalMs: 60_000 } });
    await c.request(`${base}/rl-cap`);
    expect(clock.sleeps).toEqual([5_000]);
  });

  it('429 persistente esgota as tentativas → UpstreamRateLimitedError com retryAfterMs e attempts (vale para POST)', async () => {
    handler = (_req, res) => {
      res.writeHead(429, { 'Retry-After': '1' });
      res.end('limite');
    };
    const { c } = client();
    const err = (await c.request(`${base}/rl-post`, { method: 'POST', body: 'x' }).catch((e: unknown) => e)) as UpstreamRateLimitedError;
    expect(err).toBeInstanceOf(UpstreamRateLimitedError);
    expect(err).toMatchObject({ retryAfterMs: 1000, attempts: 3, kind: 'transient', statusCode: 503 });
    expect(hits.get('/rl-post')).toBe(3);
  });
});

describe('AC4 — 5xx / rede em chamada idempotente', () => {
  it.each([503, 502])('GET com %i repete com backoff exponencial + jitter e esgota → UpstreamUnavailableError transient', async (status) => {
    handler = (_req, res) => {
      res.writeHead(status);
      res.end('fora');
    };
    const randoms = [0.25, 0.75];
    const { c, clock } = client({ random: () => randoms.shift() ?? 0, retry: { attempts: 3, baseDelayMs: 500 } });
    const err = (await c.request(`${base}/s${status}`).catch((e: unknown) => e)) as UpstreamUnavailableError;
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect(err).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', kind: 'transient', status, attempts: 3, statusCode: 503 });
    // jitter completo: tentativa 1 ∈ [0, 500), tentativa 2 ∈ [0, 1000)
    expect(clock.sleeps).toEqual([125, 750]);
    expect(hits.get(`/s${status}`)).toBe(3);
  });

  it('reset de conexão em GET repete; esgotado → UpstreamUnavailableError (status null, cause)', async () => {
    handler = (req) => req.socket.destroy();
    const { c, clock } = client();
    const err = (await c.request(`${base}/reset`).catch((e: unknown) => e)) as UpstreamUnavailableError;
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect(err).toMatchObject({ status: null, attempts: 3, kind: 'transient' });
    expect(err.cause).toBeInstanceOf(Error);
    expect(clock.sleeps).toHaveLength(2);
  });

  it('retryTransportErrors: false → timeout/rede não são repetidos nem em GET (5xx continua)', async () => {
    handler = (req) => req.socket.destroy();
    const { c } = client({ retry: { retryTransportErrors: false } });
    const err = (await c.request(`${base}/no-transport-retry`).catch((e: unknown) => e)) as UpstreamUnavailableError;
    expect(err).toMatchObject({ status: null, attempts: 1, kind: 'transient' });
    expect(hits.get('/no-transport-retry')).toBe(1);
  });

  it('GET que falha e depois responde → sucesso', async () => {
    handler = (_req, res) => {
      if ((hits.get('/flaky') ?? 0) === 1) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.end('ok');
    };
    const { c } = client();
    await expect(c.request(`${base}/flaky`)).resolves.toMatchObject({ attempts: 2 });
  });

  it('POST não idempotente com 503 → 1 tentativa, uncertain', async () => {
    handler = (_req, res) => {
      res.writeHead(503);
      res.end();
    };
    const { c, clock } = client();
    const err = (await c.request(`${base}/post503`, { method: 'POST' }).catch((e: unknown) => e)) as UpstreamUnavailableError;
    expect(err).toMatchObject({ kind: 'uncertain', attempts: 1, status: 503 });
    expect(hits.get('/post503')).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('POST não idempotente com reset → 1 tentativa, uncertain', async () => {
    handler = (req) => req.socket.destroy();
    const { c } = client();
    const err = (await c.request(`${base}/post-reset`, { method: 'POST' }).catch((e: unknown) => e)) as UpstreamUnavailableError;
    expect(err).toMatchObject({ kind: 'uncertain', attempts: 1, status: null });
    expect(hits.get('/post-reset')).toBe(1);
  });
});

describe('AC5 — 4xx permanente', () => {
  it.each([400, 401, 403, 404, 422])('%i → 1 tentativa, UpstreamRejectedError sem URL/token/corpo', async (status) => {
    handler = (_req, res) => {
      res.writeHead(status);
      res.end('corpo com SEGREDO_DO_CORPO');
    };
    const { c } = client();
    const err = (await c
      .request(`${base}/r${status}?token=SEGREDO_URL`, { headers: { Authorization: 'Bearer SEGREDO_TOKEN' } })
      .catch((e: unknown) => e)) as UpstreamRejectedError;
    expect(err).toBeInstanceOf(UpstreamRejectedError);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ code: 'UPSTREAM_REJECTED', kind: 'permanent', statusCode: 502, details: { status }, attempts: 1 });
    expect(err.message).not.toMatch(/SEGREDO|127\.0\.0\.1|token=/);
    expect(hits.get(`/r${status}`)).toBe(1);
  });

  it("httpErrors: 'return' devolve a resposta final para o chamador mapear", async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end('nada');
    };
    const { c } = client({ httpErrors: 'return' });
    const { response, attempts } = await c.request(`${base}/ret404`);
    expect(response.status).toBe(404);
    expect(attempts).toBe(1);
  });
});

describe('AC6 — orçamento total', () => {
  it('não inicia espera que ultrapasse o orçamento; erro com as tentativas reais', async () => {
    handler = (_req, res) => {
      res.writeHead(503);
      res.end();
    };
    const { c, clock } = client({ retry: { attempts: 5, baseDelayMs: 1_000, jitter: 'none', maxTotalMs: 3_500 } });
    const err = (await c.request(`${base}/budget`).catch((e: unknown) => e)) as UpstreamUnavailableError;
    // esperas 1000 + 2000 = 3000 cabem; a próxima (4000) passaria do orçamento
    expect(clock.sleeps).toEqual([1_000, 2_000]);
    expect(err).toMatchObject({ attempts: 3 });
    expect(hits.get('/budget')).toBe(3);
  });

  it('tempo das próprias chamadas conta no orçamento', async () => {
    const clock = simulatedClock();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      clock.advance(900); // cada chamada "demora" 900 ms
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    const c = createHttpClient({
      label: 'svc',
      timeoutMs: 1_000,
      fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
      retry: { attempts: 5, baseDelayMs: 100, jitter: 'none', maxTotalMs: 2_000 },
    });
    const err = (await c.request('https://svc.example/x').catch((e: unknown) => e)) as UpstreamUnavailableError;
    // t=900 + 100 ≤ 2000 → espera; t=1900 + 200 > 2000 → para
    expect(clock.sleeps).toEqual([100]);
    expect(calls).toBe(2);
    expect(err.attempts).toBe(2);
  });
});

describe('onRetry — gancho de log/progresso sem URL', () => {
  it('recebe tentativa, espera, motivo, status e Retry-After', async () => {
    handler = (_req, res) => {
      const n = hits.get('/hook') ?? 0;
      if (n === 1) {
        res.writeHead(429, { 'Retry-After': '3' });
        res.end();
      } else if (n === 2) {
        res.writeHead(500);
        res.end();
      } else res.end('ok');
    };
    const events: unknown[] = [];
    const { c } = client({ onRetry: (e) => void events.push(e), retry: { jitter: 'none', baseDelayMs: 100, maxTotalMs: 60_000 } });
    await c.request(`${base}/hook`);
    expect(events).toEqual([
      { label: 'servico-x', attempt: 1, delayMs: 3000, reason: 'rate_limited', status: 429, retryAfterMs: 3000 },
      { label: 'servico-x', attempt: 2, delayMs: 200, reason: 'server_error', status: 500, retryAfterMs: null },
    ]);
  });
});

describe('dublês de teste', () => {
  it('Response com corpo já consumido volta como veio (a leitura do chamador falha como antes)', async () => {
    const reused = new Response('{"a":1}', { status: 200 });
    await reused.text();
    const c = createHttpClient({ label: 'svc', timeoutMs: 1_000, fetchImpl: (async () => reused) as unknown as typeof fetch });
    const { response } = await c.request('https://svc.example/x');
    expect(response).toBe(reused);
    await expect(response.text()).rejects.toThrow();
  });

  it('objeto que não é Response (sem headers) com 429 não quebra o cliente', async () => {
    const duck = { ok: false, status: 429, text: async () => '' } as unknown as Response;
    const { c } = client({ httpErrors: 'return', retry: { attempts: 1 }, fetchImpl: (async () => duck) as unknown as typeof fetch });
    await expect(c.request('https://svc.example/x')).resolves.toMatchObject({ attempts: 1 });
  });
});

// AC2, AC3, AC8(c)(d), AC13, AC14, AC17, AC18 · observabilityPlugin com Fastify real + pino em memória.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCorrelationId } from '../correlation.js';
import { ERROR_CODE_KEY, isProtectedRequest, observabilityPlugin, statusClass } from '../fastify.js';
import { MetricsRegistry } from '../metrics.js';
import { REDACTED } from '../sanitize.js';
import { createLogCapture, type LogCapture } from '../testing.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
});

async function build(options: { capture?: LogCapture; metrics?: MetricsRegistry; snapshotIntervalMs?: number | false } = {}) {
  const capture = options.capture ?? createLogCapture();
  const metrics = options.metrics ?? new MetricsRegistry();
  app = Fastify({ logger: { level: 'info', stream: capture.stream } });
  await app.register(observabilityPlugin, { metrics, snapshotIntervalMs: options.snapshotIntervalMs ?? false });
  app.get('/ok', async () => ({ ok: true }));
  app.get('/jobs/:id', async (request, reply) => {
    request.log.info({ token: 'S3CR3T', customer: 'joao.silva@gmail.com' }, 'loading job');
    (reply as unknown as Record<symbol, unknown>)[ERROR_CODE_KEY] = 'plataforma.job_not_found';
    return reply.code(404).send({ code: 'plataforma.job_not_found', message: 'Job não encontrado.', error: 'Job não encontrado.', correlationId: request.correlationId });
  });
  app.get('/boom', async () => {
    throw new Error('falhou com Bearer abc.def');
  });
  app.post('/ctx', async () => {
    await new Promise((r) => setTimeout(r, 1));
    return { id: getCorrelationId() ?? null };
  });
  app.get('/inbox/mail', async (request) => {
    request.log.info({ token: 'S3CR3T' }, 'protected');
    return { correlationId: request.correlationId, ctx: getCorrelationId() ?? null };
  });
  await app.ready();
  return { app, capture, metrics };
}

describe('AC2 — header ausente ou inválido nunca muda a resposta', () => {
  it.each([
    ['ausente', undefined],
    ['vazio', ''],
    ['200 caracteres', 'x'.repeat(200)],
    ['espaços', 'com espaços aqui'],
    ['unicode', 'ünïcødé-id-1234'],
  ])('%s → 200, id novo no header', async (_label, value) => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/ok', headers: value === undefined ? {} : { 'x-correlation-id': value } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['x-correlation-id']).toMatch(UUID);
  });

  it('CR/LF (injeção de header) → id novo, sem Set-Cookie', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/ok',
      headers: { 'x-correlation-id': 'abc\r\nSet-Cookie: x' as string },
    }).catch(() => null);
    // O próprio light-my-request pode recusar o header; se passar, a API ignora o valor.
    if (res) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['x-correlation-id']).toMatch(UUID);
    }
  });

  it('id válido de 8–64 caracteres é devolvido igual', async () => {
    const { app } = await build();
    for (const id of ['ABCDEFGH', 'ABCDEFGH-1', 'a'.repeat(64)]) {
      const res = await app.inject({ method: 'GET', url: '/ok', headers: { 'x-correlation-id': id } });
      expect(res.headers['x-correlation-id']).toBe(id);
    }
  });
});

describe('AC3 — id no corpo de erro, no header e em todas as linhas de log da requisição', () => {
  it('linhas mantêm reqId e ganham correlationId; segredos mascarados', async () => {
    const { app, capture } = await build();
    const res = await app.inject({ method: 'GET', url: '/jobs/123?email=a@b.com', headers: { 'x-correlation-id': 'ABCDEFGH-1' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'plataforma.job_not_found', correlationId: 'ABCDEFGH-1' });
    expect(res.headers['x-correlation-id']).toBe('ABCDEFGH-1');
    const lines = capture.lines.filter((l) => l['msg'] !== 'incoming request');
    expect(lines.map((l) => l['msg'])).toEqual(['loading job', 'request completed']);
    for (const line of lines) {
      expect(line['reqId']).toMatch(/^req-[0-9a-z]+$/);
      expect(line['correlationId']).toBe('ABCDEFGH-1');
    }
    expect(lines[0]).toMatchObject({ token: REDACTED, customer: 'j***@g***.com' });
    expect(capture.raw.join('')).not.toContain('S3CR3T');
  });

  it('erro no handler padrão do Fastify: linha de erro sai com correlationId e mensagem mascarada', async () => {
    const { app, capture } = await build();
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    const errLine = capture.lines.find((l) => l['level'] === 50)!;
    expect(errLine['correlationId']).toBe(res.headers['x-correlation-id']);
    expect(JSON.stringify(errLine)).not.toContain('abc.def');
  });

  it('o contexto AsyncLocalStorage chega ao handler (inclusive depois do parse do corpo)', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/ctx', payload: { a: 1 }, headers: { 'x-correlation-id': 'ABCDEFGH-2' } });
    expect(res.json()).toEqual({ id: 'ABCDEFGH-2' });
  });
});

describe('AC8 (c)(d) — rota protegida intocada', () => {
  it('sem header, sem correlationId, sem contexto, log cru, sem métrica', async () => {
    const { app, capture, metrics } = await build();
    const res = await app.inject({ method: 'GET', url: '/inbox/mail', headers: { 'x-correlation-id': 'ABCDEFGH-1' } });
    expect(res.headers['x-correlation-id']).toBeUndefined();
    expect(res.json()).toEqual({ correlationId: null, ctx: null });
    for (const line of capture.lines) expect(line).not.toHaveProperty('correlationId');
    expect(capture.lines.find((l) => l['msg'] === 'protected')).toMatchObject({ token: 'S3CR3T' });
    expect(metrics.snapshot().series).toBe(0);
  });

  it('isProtectedRequest usa o padrão da rota e a URL', () => {
    expect(isProtectedRequest({ routeOptions: { url: '/inbox/:id' }, url: '/inbox/1' } as never)).toBe(true);
    expect(isProtectedRequest({ routeOptions: {}, url: '/webhooks/email/inbound/x' } as never)).toBe(true);
    expect(isProtectedRequest({ routeOptions: { url: '/jobs/:id' }, url: '/jobs/1' } as never)).toBe(false);
  });
});

describe('AC13/AC14 — métricas', () => {
  it('latência por padrão de rota, método e classe; erros por code', async () => {
    const { app, metrics } = await build();
    for (let i = 0; i < 3; i++) await app.inject({ method: 'GET', url: `/jobs/${i}?email=a@b.com` });
    await app.inject({ method: 'GET', url: '/ok' });
    await app.inject({ method: 'GET', url: '/nao-existe' });
    expect(metrics.counter('errors_total', { code: 'plataforma.job_not_found' })).toBe(3);
    const lat = metrics.snapshot().histograms['http_request_duration_ms']!;
    const labels = lat.map((s) => s.labels);
    expect(labels).toContainEqual({ method: 'GET', route: '/jobs/:id', status_class: '4xx' });
    expect(labels).toContainEqual({ method: 'GET', route: '/ok', status_class: '2xx' });
    expect(labels).toContainEqual({ method: 'GET', route: '__unmatched__', status_class: '4xx' });
    expect(JSON.stringify(labels)).not.toMatch(/a@b|\/jobs\/\d/);
    expect(lat.find((s) => s.labels['route'] === '/jobs/:id')!.count).toBe(3);
  });

  it('statusClass', () => {
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(503)).toBe('5xx');
  });
});

describe('AC17 — metrics_snapshot periódico e limpo no close', () => {
  it('emite a linha e app.close() não deixa timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const capture = createLogCapture();
    const { app, metrics } = await build({ capture, snapshotIntervalMs: 1000 });
    metrics.inc('errors_total', { code: 'x' });
    vi.advanceTimersByTime(1000);
    const line = capture.lines.find((l) => l['msg'] === 'metrics_snapshot');
    expect(line).toMatchObject({ level: 30, service: 'api' });
    expect(vi.getTimerCount()).toBe(1);
    await app.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('intervalo padrão quando não informado', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    app = Fastify({ logger: false });
    await app.register(observabilityPlugin);
    await app.ready();
    expect(vi.getTimerCount()).toBe(1);
    expect(app.observability.metrics).toBeInstanceOf(MetricsRegistry);
  });
});

describe('logger desligado (Fastify logger: false)', () => {
  it('funciona com o logger no-op', async () => {
    app = Fastify({ logger: false });
    await app.register(observabilityPlugin, { metrics: new MetricsRegistry(), snapshotIntervalMs: false });
    app.get('/ok', async (request) => {
      request.log.info('x');
      return { id: request.correlationId };
    });
    const res = await app.inject({ method: 'GET', url: '/ok', headers: { 'x-correlation-id': 'ABCDEFGH-1' } });
    expect(res.json()).toEqual({ id: 'ABCDEFGH-1' });
  });

  it('nível de log por rota é respeitado no filho', async () => {
    const capture = createLogCapture();
    app = Fastify({ logger: { level: 'info', stream: capture.stream } });
    await app.register(observabilityPlugin, { metrics: new MetricsRegistry(), snapshotIntervalMs: false });
    app.get('/quiet', { logLevel: 'warn' }, async (request) => {
      request.log.info('não aparece');
      request.log.warn('aparece');
      return {};
    });
    await app.inject({ method: 'GET', url: '/quiet' });
    expect(capture.lines.map((l) => l['msg'])).toEqual(['aparece']);
  });
});

describe('AC18 — overhead por requisição', () => {
  it('hooks + contador custam < 0,2 ms por requisição', async () => {
    const sink = { write: () => undefined };
    const plain = Fastify({ logger: { level: 'info', stream: sink } });
    plain.get('/ok', async () => ({ ok: true }));
    await plain.ready();
    const observed = Fastify({ logger: { level: 'info', stream: sink } });
    await observed.register(observabilityPlugin, { metrics: new MetricsRegistry(), snapshotIntervalMs: false });
    observed.get('/ok', async () => ({ ok: true }));
    await observed.ready();

    const run = async (target: FastifyInstance, n: number): Promise<number> => {
      const start = process.hrtime.bigint();
      for (let i = 0; i < n; i++) await target.inject({ method: 'GET', url: '/ok' });
      return Number(process.hrtime.bigint() - start) / 1e6 / n;
    };
    await run(plain, 300);
    await run(observed, 300);
    const samples: number[] = [];
    for (let round = 0; round < 3; round++) {
      const base = await run(plain, 1000);
      const withPlugin = await run(observed, 1000);
      samples.push(withPlugin - base);
    }
    await plain.close();
    await observed.close();
    expect(Math.min(...samples)).toBeLessThan(0.2);
  }, 60_000);

  it('PERF-001 — rota que loga um objeto típico (≈20 chaves): custo registrado (limite folgado 0,5 ms/req, 0,1 ms/linha)', async () => {
    const sink = { write: () => undefined };
    const typical = {
      storeId: 'c0a8012e-7d1b-4c1a-9f00-2a1b3c4d5e6f',
      productId: '3f2a9c1e-6b7d-4e8f-9a0b-1c2d3e4f5a6b',
      sku: 'BS-a3f9c1-001',
      title: 'Camiseta oversized algodão premium',
      price: 12990,
      currency: 'BRL',
      quantity: 2,
      variantIds: ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'],
      status: 'published',
      queue: 'publish-queue',
      attempt: 1,
      durationMs: 182,
      shopDomain: 'loja-exemplo.myshopify.com',
      customerEmail: 'joao.silva@gmail.com',
      url: '/admin/products/123?tab=variants',
      tags: ['verão', 'promo'],
      meta: { source: 'import', locale: 'pt-BR', market: 'BR' },
      accessToken: 'shpat_0123456789abcdef',
      ok: true,
      note: 'sincronização concluída sem divergências de preço',
    };
    const build = async (withPlugin: boolean) => {
      const instance = Fastify({ logger: { level: 'info', stream: sink } });
      if (withPlugin) await instance.register(observabilityPlugin, { metrics: new MetricsRegistry(), snapshotIntervalMs: false });
      instance.get('/log', async (request) => {
        request.log.info(typical, 'product synced');
        return { ok: true };
      });
      await instance.ready();
      return instance;
    };
    const plain = await build(false);
    const observed = await build(true);
    const run = async (target: FastifyInstance, n: number): Promise<number> => {
      const start = process.hrtime.bigint();
      for (let i = 0; i < n; i++) await target.inject({ method: 'GET', url: '/log' });
      return Number(process.hrtime.bigint() - start) / 1e6 / n;
    };
    await run(plain, 300);
    await run(observed, 300);
    const samples: number[] = [];
    for (let round = 0; round < 3; round++) {
      const base = await run(plain, 1000);
      const withPlugin = await run(observed, 1000);
      samples.push(withPlugin - base);
    }
    // Custo isolado de sanitizar uma linha (sem Fastify).
    const { sanitizeLogArgs } = await import('../logger.js');
    const lineStart = process.hrtime.bigint();
    for (let i = 0; i < 5000; i++) sanitizeLogArgs([typical, 'product synced']);
    const perLineMs = Number(process.hrtime.bigint() - lineStart) / 1e6 / 5000;
    await plain.close();
    await observed.close();
    // eslint-disable-next-line no-console
    console.info(`[PERF-001] overhead/req=${Math.min(...samples).toFixed(4)} ms; sanitize/linha=${perLineMs.toFixed(4)} ms`);
    // AC18 (< 0,2 ms) é sobre hooks + contador (teste acima, rota sem log). Aqui o custo inclui
    // sanitizar 2 linhas por requisição (a da rota e o "request completed"); limite folgado para CI.
    expect(Math.min(...samples)).toBeLessThan(0.5);
    expect(perLineMs).toBeLessThan(0.1);
  }, 60_000);
});

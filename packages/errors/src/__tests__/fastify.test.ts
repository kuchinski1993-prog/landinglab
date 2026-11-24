import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { ERROR_CODE_KEY, installErrorHandler, sendError } from '../fastify.js';
import { AppError, COMMON_ERRORS, defineCatalog } from '../index.js';

const CAT = defineCatalog('fx', {
  'fx.thing_not_found': { status: 404, message: 'Coisa não encontrada.' },
  'fx.thing_failed': { status: 500, message: 'Falha ao carregar a coisa.' },
});

interface LogLine {
  level: number;
  msg: string;
  code?: string;
  err?: { message?: string };
  status?: number;
}

function captureLogs(): { lines: LogLine[]; stream: { write: (line: string) => void } } {
  const lines: LogLine[] = [];
  return { lines, stream: { write: (line: string) => lines.push(JSON.parse(line) as LogLine) } };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('installErrorHandler — AC11 encapsulamento', () => {
  it('só afeta o plugin em que é chamado; o vizinho mantém { error, statusCode }', async () => {
    app = Fastify();
    // Handler "global antigo" no raiz, como server.ts.
    app.setErrorHandler((error, _request, reply) => {
      const statusCode = error.statusCode ?? 500;
      void reply.code(statusCode).send({ error: statusCode >= 500 ? 'Internal Server Error' : error.message, statusCode });
    });
    await app.register(async (plugin) => {
      installErrorHandler(plugin, { catalogs: [CAT] });
      plugin.get('/novo/boom', async () => {
        throw new Error('token=abc123');
      });
      plugin.get('/novo/missing', async () => {
        throw CAT.error('fx.thing_not_found', { id: '7' });
      });
    });
    await app.register(async (plugin) => {
      plugin.get('/antigo/boom', async () => {
        throw new Error('token=abc123');
      });
      plugin.get('/antigo/bad', async () => {
        throw Object.assign(new Error('Bad thing'), { statusCode: 400 });
      });
    });

    const novoBoom = await app.inject({ method: 'GET', url: '/novo/boom' });
    expect(novoBoom.statusCode).toBe(500);
    expect(novoBoom.json()).toEqual({ code: 'internal_error', message: COMMON_ERRORS.internal_error.message, error: COMMON_ERRORS.internal_error.message });
    expect(novoBoom.body).not.toContain('abc123');

    const novoMissing = await app.inject({ method: 'GET', url: '/novo/missing' });
    expect(novoMissing.statusCode).toBe(404);
    expect(novoMissing.json()).toEqual({ code: 'fx.thing_not_found', message: 'Coisa não encontrada.', details: { id: '7' }, error: 'Coisa não encontrada.' });

    const antigoBoom = await app.inject({ method: 'GET', url: '/antigo/boom' });
    expect(antigoBoom.json()).toEqual({ error: 'Internal Server Error', statusCode: 500 });
    const antigoBad = await app.inject({ method: 'GET', url: '/antigo/bad' });
    expect(antigoBad.json()).toEqual({ error: 'Bad thing', statusCode: 400 });
  });
});

describe('installErrorHandler — logs e cabeçalhos', () => {
  it('AC6: 5xx desconhecido loga o erro real com { err, code }; corpo sem o texto', async () => {
    const logs = captureLogs();
    app = Fastify({ logger: { level: 'info', stream: logs.stream } });
    await app.register(async (plugin) => {
      installErrorHandler(plugin, { catalogs: [CAT], logMessage: 'FX request failed' });
      plugin.get('/boom', async () => {
        throw new Error('token=abc123');
      });
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.body).not.toContain('abc123');
    const line = logs.lines.find((entry) => entry.msg === 'FX request failed');
    expect(line).toMatchObject({ level: 50, code: 'internal_error', err: { message: 'token=abc123' } });
  });

  it('AC9: código fora do catálogo loga aviso error_code_not_in_catalog', async () => {
    const logs = captureLogs();
    app = Fastify({ logger: { level: 'info', stream: logs.stream } });
    await app.register(async (plugin) => {
      installErrorHandler(plugin);
      plugin.get('/teapot', async () => {
        throw new AppError('I am a teapot', 418, 'x.y');
      });
    });
    const res = await app.inject({ method: 'GET', url: '/teapot' });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toMatchObject({ code: 'x.y', message: COMMON_ERRORS.validation_failed.message });
    expect(logs.lines.find((entry) => entry.msg === 'error_code_not_in_catalog')).toMatchObject({ level: 40, code: 'x.y', status: 418 });
  });

  it('UPSTREAM_RATE_LIMITED → 503 com Retry-After; validação de schema → 400 validation_failed', async () => {
    app = Fastify();
    await app.register(async (plugin) => {
      installErrorHandler(plugin);
      plugin.get('/upstream', async () => {
        throw Object.assign(new Error('Meta: 429'), { code: 'UPSTREAM_RATE_LIMITED', retryAfterMs: 3000 });
      });
      plugin.post('/schema', { schema: { body: { type: 'object', required: ['x'] } } }, async () => ({ ok: true }));
    });
    const upstream = await app.inject({ method: 'GET', url: '/upstream' });
    expect(upstream.statusCode).toBe(503);
    expect(upstream.headers['retry-after']).toBe('3');
    expect(upstream.json()).toMatchObject({ code: 'UPSTREAM_RATE_LIMITED', details: { retryAfterSeconds: 3 }, statusCode: 503 });

    const schema = await app.inject({ method: 'POST', url: '/schema', payload: {} });
    expect(schema.statusCode).toBe(400);
    expect(schema.json().code).toBe('validation_failed');
    expect(Array.isArray(schema.json().details)).toBe(true);
  });
});

describe('sendError', () => {
  it('responde o código do catálogo com o status dele', async () => {
    app = Fastify();
    app.get('/x', async (_request, reply) => sendError(reply, CAT, 'fx.thing_failed'));
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: 'fx.thing_failed', message: 'Falha ao carregar a coisa.', error: 'Falha ao carregar a coisa.' });
  });
});

describe('Story 18.4 — correlationId no corpo e marca do code para métricas', () => {
  const codeOf = (reply: unknown): unknown => (reply as Record<symbol, unknown>)[ERROR_CODE_KEY];

  async function build(include?: boolean) {
    const seen: unknown[] = [];
    app = Fastify();
    app.decorateRequest('correlationId', null);
    app.addHook('onRequest', (request, _reply, done) => {
      const id = request.headers['x-correlation-id'];
      (request as unknown as { correlationId: unknown }).correlationId = typeof id === 'string' ? id : null;
      done();
    });
    app.addHook('onResponse', (_request, reply, done) => {
      seen.push(codeOf(reply));
      done();
    });
    await app.register(async (plugin) => {
      installErrorHandler(plugin, { catalogs: [CAT], ...(include === undefined ? {} : { includeCorrelationId: include }) });
      plugin.get('/thrown', async () => {
        throw CAT.error('fx.thing_not_found');
      });
      plugin.get('/unknown', async () => {
        throw new AppError('x', 400, 'fx.nao_existe');
      });
      plugin.get('/sent', async (_request, reply) => sendError(reply, CAT, 'fx.thing_not_found'));
    });
    await app.ready();
    return seen;
  }

  it('com id na requisição: correlationId no topo do corpo (handler e sendError)', async () => {
    const seen = await build();
    for (const url of ['/thrown', '/sent']) {
      const res = await app!.inject({ method: 'GET', url, headers: { 'x-correlation-id': 'ABCDEFGH-1' } });
      expect(res.json()).toEqual({
        code: 'fx.thing_not_found',
        message: 'Coisa não encontrada.',
        error: 'Coisa não encontrada.',
        correlationId: 'ABCDEFGH-1',
      });
    }
    expect(seen).toEqual(['fx.thing_not_found', 'fx.thing_not_found']);
  });

  it('sem id (rota protegida/sem plugin): corpo idêntico ao de antes', async () => {
    await build();
    const res = await app!.inject({ method: 'GET', url: '/thrown' });
    expect(res.json()).toEqual({ code: 'fx.thing_not_found', message: 'Coisa não encontrada.', error: 'Coisa não encontrada.' });
  });

  it('includeCorrelationId: false não inclui', async () => {
    await build(false);
    const res = await app!.inject({ method: 'GET', url: '/thrown', headers: { 'x-correlation-id': 'ABCDEFGH-1' } });
    expect(res.json()).not.toHaveProperty('correlationId');
  });

  it('código fora do catálogo é marcado como unknown', async () => {
    const seen = await build();
    await app!.inject({ method: 'GET', url: '/unknown' });
    expect(seen).toEqual(['unknown']);
  });
});

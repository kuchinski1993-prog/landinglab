import { describe, expect, it } from 'vitest';

import { AppError, COMMON_CATALOG, COMMON_ERRORS, defineCatalog, toErrorResponse } from '../index.js';

const MOD = defineCatalog('modx', {
  'modx.item_not_found': { status: 404, message: 'Item não encontrado.' },
  'modx.boom': { status: 502, message: 'Falha no fornecedor.' },
});
const M = COMMON_ERRORS;

const fastifyError = (statusCode: number, code = 'FST_ERR_X') => Object.assign(new Error('Some english text'), { statusCode, code });
const pgError = (code: string) => Object.assign(new Error(`relation "secret_table" english driver text ${code}`), { code });

describe('toErrorResponse — AppError', () => {
  it('código do catálogo do módulo → status e mensagem do catálogo', () => {
    expect(toErrorResponse(MOD.error('modx.item_not_found', { id: 'a' }), { catalogs: [MOD] })).toEqual({
      status: 404,
      body: { code: 'modx.item_not_found', message: 'Item não encontrado.', details: { id: 'a' }, error: 'Item não encontrado.' },
    });
  });

  it('mensagem explícita via catalog.error vai no corpo; mensagem livre em new AppError não', () => {
    expect(toErrorResponse(MOD.error('modx.item_not_found', undefined, 'Item 7 não existe.'), { catalogs: [MOD] }).body.message).toBe(
      'Item 7 não existe.'
    );
    expect(toErrorResponse(new AppError('Item not found in english', 404, 'modx.item_not_found'), { catalogs: [MOD] }).body.message).toBe(
      'Item não encontrado.'
    );
  });

  it('código do comum é reconhecido mesmo sem passar catálogos', () => {
    expect(toErrorResponse(COMMON_CATALOG.error('version_conflict'))).toMatchObject({ status: 409, body: { code: 'version_conflict', message: M.version_conflict.message } });
  });

  it('AC9: código fora de qualquer catálogo mantém status e code, mensagem genérica do status, sinaliza unknownCode', () => {
    const res = toErrorResponse(new AppError('I am a teapot in english', 418, 'x.y'));
    expect(res).toEqual({ status: 418, body: { code: 'x.y', message: M.validation_failed.message, error: M.validation_failed.message }, unknownCode: true });
    expect(JSON.stringify(res.body)).not.toContain('english');
    expect(toErrorResponse(new AppError('english', 503, 'x.z')).body.message).toBe(M.service_unavailable.message);
  });

  it('AppError sem código cai por status', () => {
    expect(toErrorResponse(new AppError('english', 404)).body.code).toBe('not_found');
    expect(toErrorResponse(new AppError('english', 401)).body.code).toBe('unauthorized');
    expect(toErrorResponse(new AppError('english', 409)).body.code).toBe('constraint_conflict');
    expect(toErrorResponse(new AppError('english', 429)).body.code).toBe('rate_limited');
    expect(toErrorResponse(new AppError('english', 403)).body).toEqual({ code: 'forbidden', message: M.forbidden.message, error: M.forbidden.message });
    expect(toErrorResponse(new AppError('english', 405)).body).toEqual({ code: 'method_not_allowed', message: M.method_not_allowed.message, error: M.method_not_allowed.message });
    expect(toErrorResponse(new AppError('english', 406)).body.code).toBe('validation_failed');
    expect(toErrorResponse(new AppError('english', 500)).body).toEqual({ code: 'internal_error', message: M.internal_error.message, error: M.internal_error.message });
    expect(toErrorResponse(new AppError('english')).body.code).toBe('validation_failed');
  });

  it('statusCode inválido em AppError (fora de 400–599) vira 500', () => {
    expect(toErrorResponse(new AppError('english', 200)).status).toBe(500);
    expect(toErrorResponse(new AppError('english', 302, 'x.w')).status).toBe(500);
  });

  it('AC7: AppError ≥ 500 declarado só leva details se o chamador passou', () => {
    expect(toErrorResponse(MOD.error('modx.boom'), { catalogs: [MOD] }).body).not.toHaveProperty('details');
    expect(toErrorResponse(MOD.error('modx.boom', { provider: 'x' }), { catalogs: [MOD] }).body.details).toEqual({ provider: 'x' });
  });
});

describe('toErrorResponse — AC6 erro desconhecido não vaza nada', () => {
  it.each<[string, unknown]>([
    ['Error com segredo', new Error('token=abc123')],
    ['TypeError', new TypeError('Cannot read properties of undefined (reading "x")')],
    ['Error com statusCode 503 (não AppError)', Object.assign(new Error('token=abc123'), { statusCode: 503 })],
    ['pg não mapeado', pgError('23502')],
    ['string', 'token=abc123'],
    ['null', null],
    ['undefined', undefined],
  ])('%s → 500 internal_error genérico', (_name, error) => {
    const res = toErrorResponse(error);
    expect(res).toEqual({ status: 500, body: { code: 'internal_error', message: M.internal_error.message, error: M.internal_error.message }, unexpected: true });
    const text = JSON.stringify(res.body);
    for (const leak of ['token', 'abc123', 'Error', 'stack', 'undefined', 'secret_table', 'english']) expect(text).not.toContain(leak);
  });
});

describe('toErrorResponse — AC8 erro do cliente nunca é 500', () => {
  it.each<[string, unknown, number, string, unknown]>([
    ['validação de schema', Object.assign(new Error('x'), { validation: [{ message: 'bad' }], statusCode: 400 }), 400, 'validation_failed', [{ message: 'bad' }]],
    ['UUID malformado (22P02)', pgError('22P02'), 400, 'validation_failed', { reason: 'invalid_id' }],
    ['22P02 em cause (drizzle)', Object.assign(new Error('wrap'), { cause: { code: '22P02' } }), 400, 'validation_failed', { reason: 'invalid_id' }],
    ['unicidade (23505)', pgError('23505'), 409, 'constraint_conflict', undefined],
    ['FK (23503)', pgError('23503'), 409, 'constraint_conflict', undefined],
    ['CHECK (23514)', pgError('23514'), 409, 'constraint_conflict', undefined],
    ['corpo grande', fastifyError(413, 'FST_ERR_CTP_BODY_TOO_LARGE'), 413, 'validation_failed', { reason: 'payload_too_large' }],
    ['mídia não suportada', fastifyError(415, 'FST_ERR_CTP_INVALID_MEDIA_TYPE'), 415, 'validation_failed', { reason: 'unsupported_media_type' }],
    ['404 do Fastify', fastifyError(404, 'FST_ERR_NOT_FOUND'), 404, 'not_found', undefined],
    ['429 do rate-limit', fastifyError(429), 429, 'rate_limited', undefined],
    ['401 genérico', fastifyError(401), 401, 'unauthorized', undefined],
    ['400 genérico', fastifyError(400), 400, 'validation_failed', undefined],
    // Story 18.11 (A1): 403/405 com código próprio; 406/422 seguem validation_failed.
    ['403 genérico', fastifyError(403), 403, 'forbidden', undefined],
    ['405 do Fastify', fastifyError(405), 405, 'method_not_allowed', undefined],
    ['406 genérico', fastifyError(406), 406, 'validation_failed', undefined],
    ['422 genérico', fastifyError(422), 422, 'validation_failed', undefined],
  ])('%s → %i %s', (_name, error, status, code, details) => {
    const res = toErrorResponse(error);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(res.body.details).toEqual(details);
    expect(res.body.message).toBe(res.body.error);
    expect(JSON.stringify(res.body)).not.toMatch(/english|secret_table/);
    expect(res.unexpected).toBeUndefined();
  });
});

describe('toErrorResponse — AC10 legados UPSTREAM_* (duck typing por err.code)', () => {
  class UpstreamTimeoutError extends Error {
    readonly code = 'UPSTREAM_TIMEOUT' as const;
    readonly statusCode = 504;
  }
  class UpstreamRateLimitedError extends Error {
    readonly code = 'UPSTREAM_RATE_LIMITED' as const;
    constructor(
      message: string,
      readonly retryAfterMs: number | null
    ) {
      super(message);
    }
  }

  it('UPSTREAM_TIMEOUT → 504 { code, message, error, statusCode }', () => {
    expect(toErrorResponse(new UpstreamTimeoutError('Shopify: sem resposta em 5000 ms'))).toEqual({
      status: 504,
      body: { code: 'UPSTREAM_TIMEOUT', message: M.UPSTREAM_TIMEOUT.message, error: M.UPSTREAM_TIMEOUT.message, statusCode: 504 },
    });
  });

  it('UPSTREAM_RATE_LIMITED → 503 com details.retryAfterSeconds e header Retry-After', () => {
    expect(toErrorResponse(new UpstreamRateLimitedError('Meta: 429', 1500))).toEqual({
      status: 503,
      body: {
        code: 'UPSTREAM_RATE_LIMITED',
        message: M.UPSTREAM_RATE_LIMITED.message,
        details: { retryAfterSeconds: 2 },
        error: M.UPSTREAM_RATE_LIMITED.message,
        statusCode: 503,
      },
      headers: { 'retry-after': '2' },
    });
  });

  it.each([null, Number.NaN, -1, Number.POSITIVE_INFINITY])('UPSTREAM_RATE_LIMITED sem Retry-After válido (%s) → sem details/header', (ms) => {
    const res = toErrorResponse(new UpstreamRateLimitedError('Meta: 429', ms));
    expect(res.status).toBe(503);
    expect(res.body).not.toHaveProperty('details');
    expect(res.headers).toBeUndefined();
  });

  it('mensagem do legado nunca é a do erro (que cita serviço/prazo)', () => {
    expect(JSON.stringify(toErrorResponse(new UpstreamTimeoutError('Shopify: sem resposta em 5000 ms')).body)).not.toContain('Shopify');
  });

  it.each([
    ['UPSTREAM_UNAVAILABLE', 503],
    ['UPSTREAM_REJECTED', 502],
  ] as const)('Story 18.2 · %s → %i com a mensagem do catálogo (nunca a do erro)', (code, status) => {
    const err = Object.assign(new Error('shopify-admin: HTTP 401 https://loja.myshopify.com'), { code });
    expect(toErrorResponse(err)).toEqual({
      status,
      body: { code, message: M[code].message, error: M[code].message, statusCode: status },
    });
  });
});

describe("toErrorResponse — compat: 'vsl'", () => {
  const VSL_LIKE = defineCatalog(
    'vsl-like',
    {
      payload_too_large: { status: 413, message: 'Arquivo grande.' },
      unsupported_media_type: { status: 415, message: 'Mídia ruim.' },
      stream_unavailable: { status: 502, message: 'Stream fora.' },
      thing_conflict: { status: 409, message: 'Conflito de coisa.' },
    },
    {
      prefix: '',
      base: COMMON_CATALOG,
      include: ['validation_failed', 'not_found', 'constraint_conflict', 'internal_error', 'service_unavailable'],
      overrides: { internal_error: 'Erro interno no produto.' },
    }
  );
  const opts = { catalogs: [VSL_LIKE], compat: 'vsl' as const };
  const b = (code: string, message: string, details?: unknown) => ({ code, message, ...(details === undefined ? {} : { details }), error: message });

  it('AppError com código conhecido: status do erro e mensagem livre preservados (contrato VSL)', () => {
    expect(toErrorResponse(new AppError('Texto específico', 400, 'thing_conflict', { a: 1 }), opts)).toEqual({ status: 400, body: b('thing_conflict', 'Texto específico', { a: 1 }) });
    expect(toErrorResponse(new AppError('Conflito de coisa.', 409, 'thing_conflict'), opts)).toEqual({ status: 409, body: b('thing_conflict', 'Conflito de coisa.') });
    expect(toErrorResponse(new AppError('', 409, 'thing_conflict'), opts).body.message).toBe('Conflito de coisa.');
  });

  it('código fora do catálogo do VSL (inclusive códigos do comum não incluídos) cai por status, sem details', () => {
    expect(toErrorResponse(new AppError('x', 429, 'rate_limited', { a: 1 }), opts)).toEqual({ status: 429, body: b('validation_failed', M.validation_failed.message) });
    expect(toErrorResponse(new AppError('x', 504, 'UPSTREAM_TIMEOUT'), opts)).toEqual({ status: 504, body: b('internal_error', 'Erro interno no produto.') });
  });

  it.each<[number, string, string]>([
    [404, 'not_found', M.not_found.message],
    [409, 'constraint_conflict', M.constraint_conflict.message],
    [413, 'payload_too_large', 'Arquivo grande.'],
    [502, 'stream_unavailable', 'Stream fora.'],
    [503, 'service_unavailable', M.service_unavailable.message],
    [500, 'internal_error', 'Erro interno no produto.'],
    [401, 'validation_failed', M.validation_failed.message],
    // Story 18.11: o ramo VSL é congelado — 403/405 continuam validation_failed.
    [403, 'validation_failed', M.validation_failed.message],
    [405, 'validation_failed', M.validation_failed.message],
  ])('AppError sem código %i → %s', (status, code, message) => {
    expect(toErrorResponse(new AppError('english', status), opts)).toEqual({ status, body: b(code, message) });
  });

  it('erros não-AppError seguem o mapeamento do VSL', () => {
    expect(toErrorResponse(Object.assign(new Error('x'), { validation: [1] }), opts)).toEqual({ status: 400, body: b('validation_failed', M.validation_failed.message, [1]) });
    expect(toErrorResponse(fastifyError(413, 'FST_ERR_CTP_BODY_TOO_LARGE'), opts)).toEqual({ status: 413, body: b('payload_too_large', 'Arquivo grande.') });
    expect(toErrorResponse(fastifyError(415, 'FST_ERR_CTP_INVALID_MEDIA_TYPE'), opts)).toEqual({ status: 415, body: b('unsupported_media_type', 'Mídia ruim.') });
    expect(toErrorResponse(fastifyError(404), opts)).toEqual({ status: 404, body: b('not_found', M.not_found.message) });
    expect(toErrorResponse(fastifyError(429), opts)).toEqual({ status: 429, body: b('validation_failed', M.validation_failed.message) });
    expect(toErrorResponse(fastifyError(403), opts)).toEqual({ status: 403, body: b('validation_failed', M.validation_failed.message) });
    expect(toErrorResponse(fastifyError(405), opts)).toEqual({ status: 405, body: b('validation_failed', M.validation_failed.message) });
    expect(toErrorResponse(pgError('22P02'), opts)).toEqual({ status: 400, body: b('validation_failed', M.validation_failed.message, { reason: 'invalid_id' }) });
    expect(toErrorResponse(pgError('23505'), opts)).toEqual({ status: 409, body: b('constraint_conflict', M.constraint_conflict.message) });
    expect(toErrorResponse(Object.assign(new Error('x'), { code: 'UPSTREAM_TIMEOUT', statusCode: 504 }), opts)).toMatchObject({ status: 500, body: b('internal_error', 'Erro interno no produto.') });
    expect(toErrorResponse('boom', opts)).toMatchObject({ status: 500, body: b('internal_error', 'Erro interno no produto.') });
  });

  it('código de fallback ausente no catálogo usa a mensagem genérica do comum', () => {
    const bare = defineCatalog('bare', {}, { prefix: '' });
    expect(toErrorResponse(new AppError('x', 502), { catalogs: [bare], compat: 'vsl' })).toEqual({
      status: 502,
      body: b('stream_unavailable', M.internal_error.message),
    });
  });
});

// Story 18.1 (AC5) · Congela o contrato atual de toVslErrorResponse ANTES da migração para
// @blackshop/errors. Deve passar igual antes e depois: qualquer diferença aqui é regressão
// observável no VSL Hosting.
import { describe, expect, it } from 'vitest';

import { toVslErrorResponse, vslError } from '../errors.js';
import { VslError } from '../imports.js';

const body = (code: string, message: string, details?: unknown) => ({
  code,
  message,
  ...(details === undefined ? {} : { details }),
  error: message,
});

const MSG = {
  validation_failed: 'Dados inválidos na requisição.',
  not_found: 'Recurso não encontrado.',
  constraint_conflict: 'A alteração conflita com dados existentes.',
  payload_too_large: 'Arquivo acima do limite permitido.',
  unsupported_media_type: 'Envie um arquivo HTML ou ZIP.',
  stream_unavailable: 'Cloudflare Stream indisponível. Tente novamente.',
  service_unavailable: 'Serviço do VSL indisponível no momento.',
  internal_error: 'Erro interno no VSL. Tente novamente.',
  pathname_conflict: 'Este caminho já está em uso.',
} as const;

const fastifyError = (statusCode: number, code = 'FST_ERR_X', message = 'Some english text') =>
  Object.assign(new Error(message), { statusCode, code });
const pgError = (code: string) => Object.assign(new Error(`pg ${code} english detail`), { code });

describe('toVslErrorResponse — caracterização (contrato congelado)', () => {
  it.each<[string, unknown, number, ReturnType<typeof body>]>([
    // VslError com código do catálogo
    ['vslError com details', vslError('pathname_conflict', { pathname: '/a' }), 409, body('pathname_conflict', MSG.pathname_conflict, { pathname: '/a' })],
    ['vslError sem details', vslError('pathname_conflict'), 409, body('pathname_conflict', MSG.pathname_conflict)],
    ['vslError com mensagem própria', vslError('pathname_conflict', undefined, 'Outra'), 409, body('pathname_conflict', 'Outra')],
    ['VslError código conhecido, status do erro prevalece', new VslError('x', 400, 'pathname_conflict'), 400, body('pathname_conflict', 'x')],
    ['VslError código conhecido, mensagem vazia', new VslError('', 409, 'pathname_conflict'), 409, body('pathname_conflict', MSG.pathname_conflict)],
    // VslError sem código (ou código fora do catálogo) cai por status, sem details
    ['VslError sem código 400', new VslError('Legacy english', 400, undefined, { a: 1 }), 400, body('validation_failed', MSG.validation_failed)],
    ['VslError sem código 401', new VslError('x', 401), 401, body('validation_failed', MSG.validation_failed)],
    ['VslError 404', new VslError('x', 404), 404, body('not_found', MSG.not_found)],
    ['VslError 409', new VslError('x', 409), 409, body('constraint_conflict', MSG.constraint_conflict)],
    ['VslError 413', new VslError('x', 413), 413, body('payload_too_large', MSG.payload_too_large)],
    ['VslError 502', new VslError('x', 502), 502, body('stream_unavailable', MSG.stream_unavailable)],
    ['VslError 503', new VslError('x', 503), 503, body('service_unavailable', MSG.service_unavailable)],
    ['VslError 500', new VslError('x', 500), 500, body('internal_error', MSG.internal_error)],
    ['VslError 501', new VslError('x', 501), 501, body('internal_error', MSG.internal_error)],
    ['VslError código desconhecido', new VslError('x', 404, 'nao.existe'), 404, body('not_found', MSG.not_found)],
    // Fastify
    ['validação do Fastify', Object.assign(new Error('x'), { validation: [{ message: 'bad' }], statusCode: 400 }), 400, body('validation_failed', MSG.validation_failed, [{ message: 'bad' }])],
    ['FST_ERR_CTP_BODY_TOO_LARGE', fastifyError(413, 'FST_ERR_CTP_BODY_TOO_LARGE'), 413, body('payload_too_large', MSG.payload_too_large)],
    ['FST_ERR_CTP_INVALID_MEDIA_TYPE', fastifyError(415, 'FST_ERR_CTP_INVALID_MEDIA_TYPE'), 415, body('unsupported_media_type', MSG.unsupported_media_type)],
    ['404 do Fastify', fastifyError(404), 404, body('not_found', MSG.not_found)],
    ['429 do rate-limit', fastifyError(429), 429, body('validation_failed', MSG.validation_failed)],
    ['401 genérico do Fastify', fastifyError(401), 401, body('validation_failed', MSG.validation_failed)],
    // Postgres
    ['22P02', pgError('22P02'), 400, body('validation_failed', MSG.validation_failed, { reason: 'invalid_id' })],
    ['22P02 em cause', Object.assign(new Error('wrap'), { cause: { code: '22P02' } }), 400, body('validation_failed', MSG.validation_failed, { reason: 'invalid_id' })],
    ['23505', pgError('23505'), 409, body('constraint_conflict', MSG.constraint_conflict)],
    ['23503', pgError('23503'), 409, body('constraint_conflict', MSG.constraint_conflict)],
    ['23514', pgError('23514'), 409, body('constraint_conflict', MSG.constraint_conflict)],
    ['23502 (não mapeado)', pgError('23502'), 500, body('internal_error', MSG.internal_error)],
    // Desconhecidos
    ['Error genérico', new Error('token=abc123'), 500, body('internal_error', MSG.internal_error)],
    ['Error com statusCode 503 (não VslError)', fastifyError(503), 500, body('internal_error', MSG.internal_error)],
    ['UPSTREAM_TIMEOUT (sem ramo próprio no VSL)', Object.assign(new Error('Shopify: sem resposta'), { code: 'UPSTREAM_TIMEOUT', statusCode: 504 }), 500, body('internal_error', MSG.internal_error)],
    ['UPSTREAM_RATE_LIMITED (sem ramo próprio no VSL)', Object.assign(new Error('Meta: 429'), { code: 'UPSTREAM_RATE_LIMITED', retryAfterMs: 2000 }), 500, body('internal_error', MSG.internal_error)],
    ['string lançada', 'boom', 500, body('internal_error', MSG.internal_error)],
    ['null lançado', null, 500, body('internal_error', MSG.internal_error)],
  ])('%s', (_name, error, status, expected) => {
    const result = toVslErrorResponse(error);
    expect(result).toEqual({ status, body: expected });
    expect(Object.keys(result).sort()).toEqual(['body', 'status']);
    expect(Object.keys(result.body)).toEqual(Object.keys(expected));
  });

  it('VslError continua instanceof Error e mantém a assinatura (message, statusCode, code, details)', () => {
    const error = new VslError('m', 409, 'pathname_conflict', { a: 1 });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(VslError);
    expect([error.message, error.statusCode, error.code, error.details]).toEqual(['m', 409, 'pathname_conflict', { a: 1 }]);
    expect(new VslError('default').statusCode).toBe(400);
  });
});

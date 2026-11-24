// Adoção por plugin encapsulado: chame DENTRO do plugin do módulo. Nunca no app raiz — o handler
// global de server.ts também responde rotas de zonas protegidas (Tracker, TrustShield).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Catalog, ErrorBody, ErrorEntries } from './catalog.js';
import { toErrorResponse, type ToErrorResponseOptions } from './to-response.js';

/**
 * Story 18.4 · marca na reply com o `code` do corpo de erro (`'unknown'` fora do catálogo), lida
 * pelo observabilityPlugin para `errors_total{code}`. Símbolo global: sem dependência entre pacotes.
 */
export const ERROR_CODE_KEY = Symbol.for('blackshop.errors.code');

export interface InstallErrorHandlerOptions extends ToErrorResponseOptions {
  /** Texto do log de 5xx (padrão: 'Request failed'). */
  logMessage?: string;
  /**
   * Story 18.4 · inclui `correlationId` (topo do corpo) quando a requisição tem um — só rotas não
   * protegidas com o observabilityPlugin. Padrão: true.
   */
  includeCorrelationId?: boolean;
}

function correlationIdOf(request: FastifyRequest): string | undefined {
  const id = (request as { correlationId?: unknown }).correlationId;
  return typeof id === 'string' && id ? id : undefined;
}

function withCorrelationId<B extends ErrorBody>(body: B, request: FastifyRequest, include: boolean): B {
  const correlationId = include ? correlationIdOf(request) : undefined;
  return correlationId ? { ...body, correlationId } : body;
}

function markErrorCode(reply: FastifyReply, code: string): void {
  (reply as unknown as Record<symbol, unknown>)[ERROR_CODE_KEY] = code;
}

export function installErrorHandler(app: FastifyInstance, options: InstallErrorHandlerOptions = {}): void {
  const { logMessage = 'Request failed', includeCorrelationId = true, ...responseOptions } = options;
  app.setErrorHandler((error, request, reply) => {
    const response = toErrorResponse(error, responseOptions);
    if (response.status >= 500) request.log.error({ err: error, code: response.body.code }, logMessage);
    else if (response.unknownCode)
      request.log.warn({ code: response.body.code, status: response.status }, 'error_code_not_in_catalog');
    if (response.headers) void reply.headers(response.headers);
    markErrorCode(reply, response.unknownCode ? 'unknown' : response.body.code);
    return reply.code(response.status).send(withCorrelationId(response.body, request, includeCorrelationId));
  });
}

/** Responde um código do catálogo direto da rota (sem lançar). */
export function sendError<E extends ErrorEntries>(
  reply: FastifyReply,
  catalog: Catalog<E>,
  code: Extract<keyof E, string>,
  details?: unknown,
  message?: string
): FastifyReply {
  const entry = catalog.get(code);
  markErrorCode(reply, entry ? code : 'unknown');
  return reply.code(entry?.status ?? 500).send(withCorrelationId(catalog.body(code, details, message), reply.request, true));
}

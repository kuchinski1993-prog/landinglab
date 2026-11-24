// Story 18.4 · observabilityPlugin (Fastify). Registrar no app raiz ANTES dos plugins de rota.
//
// Só em rotas NÃO protegidas (PROTECTED_ROUTE_PREFIXES):
//   onRequest  → id do header `X-Correlation-Id` (validado) ou UUID novo; `request.correlationId`;
//                `request.log`/`reply.log` viram filho sanitizado com { reqId, correlationId };
//                contexto AsyncLocalStorage (o enqueue da fila lê o id dele);
//   onSend     → header `X-Correlation-Id` na resposta;
//   onResponse → http_request_duration_ms{method,route,status_class} e errors_total{code}.
// Em rota protegida todos os hooks retornam sem efeito. As opções do `Fastify(...)` e do pino raiz
// não mudam (reqId continua `req-N` em todas as linhas). Hooks síncronos (callback), sem I/O.
import { AsyncResource } from 'node:async_hooks';

import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { CORRELATION_HEADER, correlationStorage, resolveCorrelationId } from './correlation.js';
import { createSanitizedLogger, type PinoLike } from './logger.js';
import { MetricsRegistry, startSnapshotLog, type SnapshotLogHandle } from './metrics.js';
import { isProtectedPath, PROTECTED_ROUTE_PREFIXES } from './protected.js';

/**
 * Marca posta na reply por `@blackshop/errors` (handler da 18.1 e `sendError`) com o `code` do
 * corpo de erro (`'unknown'` fora do catálogo). Símbolo global: os pacotes não se importam.
 */
export const ERROR_CODE_KEY = Symbol.for('blackshop.errors.code');

const RESOURCE = Symbol('blackshop.observability.resource');
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    /** Story 18.4 · id de correlação; `null` em rota protegida (ou sem o plugin). */
    correlationId: string | null;
  }
  interface FastifyInstance {
    /** Story 18.4 · registro de métricas da API (lido por GET /admin/metrics). */
    observability: { metrics: MetricsRegistry };
  }
}

export interface ObservabilityPluginOptions {
  /** Padrão: um registro novo por instância. */
  metrics?: MetricsRegistry;
  protectedRoutePrefixes?: readonly string[];
  /** Linha `metrics_snapshot` periódica (padrão 60 s); `false` desliga. */
  snapshotIntervalMs?: number | false;
}

type RequestWithResource = FastifyRequest & { [RESOURCE]?: AsyncResource };

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export function isProtectedRequest(request: FastifyRequest, prefixes: readonly string[] = PROTECTED_ROUTE_PREFIXES): boolean {
  return isProtectedPath(request.routeOptions?.url, prefixes) || isProtectedPath(request.url, prefixes);
}

const plugin: FastifyPluginCallback<ObservabilityPluginOptions> = (fastify, options, done) => {
  const prefixes = options.protectedRoutePrefixes ?? PROTECTED_ROUTE_PREFIXES;
  const metrics = options.metrics ?? new MetricsRegistry();
  const template = createSanitizedLogger(fastify.log as unknown as PinoLike);

  fastify.decorate('observability', { metrics });
  fastify.decorateRequest('correlationId', null);

  fastify.addHook('onRequest', (request, reply, next) => {
    if (isProtectedRequest(request, prefixes)) return next();
    const correlationId = resolveCorrelationId(request.headers[CORRELATION_HEADER]);
    request.correlationId = correlationId;
    const level = (request.log as unknown as PinoLike).level;
    const bindings = { reqId: request.id, correlationId };
    const log = (level === template.level ? template.child(bindings) : template.child(bindings, { level })) as unknown as FastifyRequest['log'];
    request.log = log;
    (reply as { log: FastifyReply['log'] }).log = log;
    correlationStorage.run({ correlationId, logger: log }, () => {
      (request as RequestWithResource)[RESOURCE] = new AsyncResource('blackshop-correlation');
      next();
    });
  });

  // O parse do corpo roda em callbacks de stream (perde o contexto): reentra antes do handler.
  fastify.addHook('preValidation', (request, _reply, next) => {
    const resource = (request as RequestWithResource)[RESOURCE];
    if (resource) resource.runInAsyncScope(next);
    else next();
  });

  fastify.addHook('onSend', (request, reply, payload, next) => {
    if (request.correlationId) void reply.header(CORRELATION_HEADER, request.correlationId);
    next(null, payload);
  });

  fastify.addHook('onResponse', (request, reply, next) => {
    if (request.correlationId) {
      try {
        const method = KNOWN_METHODS.has(request.method) ? request.method : 'OTHER';
        const route = request.routeOptions?.url ?? '__unmatched__';
        metrics.observe('http_request_duration_ms', { method, route, status_class: statusClass(reply.statusCode) }, reply.elapsedTime);
        const code = (reply as unknown as Record<symbol, unknown>)[ERROR_CODE_KEY];
        if (typeof code === 'string') metrics.inc('errors_total', { code });
      } catch {
        // Métrica nunca afeta a resposta.
      }
    }
    next();
  });

  let snapshot: SnapshotLogHandle | null = null;
  if (options.snapshotIntervalMs !== false) {
    snapshot = startSnapshotLog(metrics, fastify.log, {
      ...(options.snapshotIntervalMs ? { intervalMs: options.snapshotIntervalMs } : {}),
      extra: () => ({ service: 'api' }),
    });
  }
  fastify.addHook('onClose', (_instance, next) => {
    snapshot?.stop();
    next();
  });

  done();
};

export const observabilityPlugin = fp(plugin, { name: 'observability-plugin', fastify: '4.x' });
export default observabilityPlugin;

// Story 0.4 · modo das integrações na API: checkout falha alto (503) quando o SHOPIFY_MODE
// não está configurado em produção, health mostra os modos e o boot loga o alerta.
import { toErrorResponse } from '@blackshop/errors';
import { isUpstreamTimeoutError, type UpstreamError, type UpstreamTimeoutError } from '@blackshop/shared/http';
import {
  buildModeAlertLines,
  describeIntegrationModes,
  type IntegrationModeError,
  type IntegrationModeStatus,
  type RuntimeEnv,
} from '@blackshop/shared/runtime-mode';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';

export const SHOPIFY_MODE_NOT_CONFIGURED = 'SHOPIFY_MODE_NOT_CONFIGURED';

/** Chave Redis onde o worker publica os modos resolvidos dele (mesmo TTL do heartbeat). */
export const WORKER_MODES_KEY = 'worker:modes';

export const CHECKOUT_UNAVAILABLE_MESSAGE =
  'O checkout está temporariamente indisponível. Tente novamente em alguns minutos.';

/**
 * 503 `{ code: 'SHOPIFY_MODE_NOT_CONFIGURED' }` com mensagem genérica ao cliente; o detalhe
 * técnico (variável, código do resolver) fica só no log, em nível `error`. `error` e
 * `statusCode` continuam no corpo por compatibilidade com o storefront (CartDrawer lê `error`).
 */
export function replyShopifyModeNotConfigured(
  request: FastifyRequest,
  reply: FastifyReply,
  err: IntegrationModeError,
  route: string,
): FastifyReply {
  request.log.error(
    {
      event: SHOPIFY_MODE_NOT_CONFIGURED,
      route,
      resolverCode: err.code,
      variable: err.variable,
    },
    `${route}: ${err.message}`,
  );
  return reply.code(503).send({
    code: SHOPIFY_MODE_NOT_CONFIGURED,
    message: CHECKOUT_UNAVAILABLE_MESSAGE,
    details: { retryable: false },
    error: CHECKOUT_UNAVAILABLE_MESSAGE,
    statusCode: 503,
  });
}

/**
 * Story 0.8 · 504 `{ code: 'UPSTREAM_TIMEOUT' }` quando a Shopify não responde no checkout.
 * Nenhuma URL de checkout parcial; detalhe (serviço, prazo, incerteza) só no log.
 */
export function replyUpstreamTimeout(
  request: FastifyRequest,
  reply: FastifyReply,
  err: UpstreamTimeoutError,
  route: string,
): FastifyReply {
  request.log.error(
    { event: err.code, route, label: err.label, timeoutMs: err.timeoutMs, uncertain: err.uncertain },
    `${route}: ${err.message}`,
  );
  return reply.code(504).send({
    code: err.code,
    message: CHECKOUT_UNAVAILABLE_MESSAGE,
    error: CHECKOUT_UNAVAILABLE_MESSAGE,
    statusCode: 504,
  });
}

export interface ReplyUpstreamFailureOptions {
  /** Mensagem PT-BR para o cliente (ex.: checkout usa a de indisponibilidade). Padrão: a do catálogo. */
  message?: string;
}

/**
 * Story 18.2 · resposta tipada para falha de terceiro, por rota (o handler global de server.ts
 * não muda). Timeout → 504 `UPSTREAM_TIMEOUT` (mesmo corpo de `replyUpstreamTimeout`). 429 esgotado → 503 `UPSTREAM_RATE_LIMITED`
 * + `details.retryAfterSeconds` e header `Retry-After` quando houver; 5xx/rede → 503
 * `UPSTREAM_UNAVAILABLE`; 4xx → 502 `UPSTREAM_REJECTED`. Corpo `{ code, message, error,
 * statusCode }` (legado da família UPSTREAM_*); serviço, tipo e tentativas só no log — nunca
 * URL, token ou corpo do terceiro.
 */
export function replyUpstreamFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  err: UpstreamError,
  route: string,
  options: ReplyUpstreamFailureOptions = {},
): FastifyReply {
  const status = (err as { status?: unknown }).status;
  request.log.error(
    {
      event: err.code,
      route,
      label: err.label,
      kind: err.kind,
      attempts: err.attempts,
      ...(typeof status === 'number' ? { upstreamStatus: status } : {}),
      ...(isUpstreamTimeoutError(err) ? { timeoutMs: err.timeoutMs, uncertain: err.uncertain } : {}),
    },
    `${route}: falha no serviço externo (${err.code})`,
  );
  const { status: httpStatus, body, headers } = toErrorResponse(err);
  for (const [name, value] of Object.entries(headers ?? {})) void reply.header(name, value);
  const message = options.message ?? body.message;
  return reply.code(httpStatus).send({ ...body, message, error: message });
}

export interface WorkerModes {
  shopify: IntegrationModeStatus;
  metaCapi: IntegrationModeStatus;
  productionMock: boolean;
  productionModeError: boolean;
}

function isStatus(value: unknown): value is IntegrationModeStatus {
  if (!value || typeof value !== 'object') return false;
  const v = value as { mode?: unknown; source?: unknown };
  return typeof v.mode === 'string' && typeof v.source === 'string';
}

/** Lê o JSON publicado pelo worker; qualquer formato inesperado vira `null`. */
export function parseWorkerModes(raw: string | null | undefined): WorkerModes | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkerModes>;
    if (!isStatus(parsed.shopify) || !isStatus(parsed.metaCapi)) return null;
    return {
      shopify: parsed.shopify,
      metaCapi: parsed.metaCapi,
      productionMock: parsed.productionMock === true,
      productionModeError: parsed.productionModeError === true,
    };
  } catch {
    return null;
  }
}

export interface HealthIntegrations {
  integrations: {
    shopify: IntegrationModeStatus;
    metaCapi: IntegrationModeStatus;
    worker: { shopify: IntegrationModeStatus; metaCapi: IntegrationModeStatus } | null;
  };
  productionMock: boolean;
  /** true quando o health deve sinalizar `status: 'degraded'` por causa dos modos. */
  degraded: boolean;
}

export function buildHealthIntegrations(
  workerModesRaw: string | null | undefined,
  env: RuntimeEnv = process.env,
): HealthIntegrations {
  const api = describeIntegrationModes(env);
  const worker = parseWorkerModes(workerModesRaw);
  const productionMock = api.productionMock || (worker?.productionMock ?? false);
  const modeError = api.productionModeError || (worker?.productionModeError ?? false);
  return {
    integrations: {
      shopify: api.shopify,
      metaCapi: api.metaCapi,
      worker: worker ? { shopify: worker.shopify, metaCapi: worker.metaCapi } : null,
    },
    productionMock,
    degraded: productionMock || modeError,
  };
}

/** AC9 · uma linha por subsistema no boot (error em produção com mock/erro; info em dev). */
export function logIntegrationModes(
  log: Pick<FastifyBaseLogger, 'error' | 'warn' | 'info'>,
  service: string,
  env: RuntimeEnv = process.env,
): void {
  for (const line of buildModeAlertLines(service, env)) {
    const { level, message, ...fields } = line;
    log[level](fields, message);
  }
}

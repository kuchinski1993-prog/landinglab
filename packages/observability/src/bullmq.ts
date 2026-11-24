// Story 18.4 · Correlation id na fila: `opts.telemetry.metadata = "cid:<id>"` (spike T1: o
// BullMQ 5.78 persiste e devolve em `job.opts` sem OpenTelemetry configurado). `job.data` nunca
// muda. Filas protegidas: opts e processor intocados (mesma referência).
import { correlationStorage, getCorrelationId, JOB_METADATA_PREFIX, newCorrelationId, parseCorrelationId } from './correlation.js';
import { createSanitizedLogger, type PinoLike } from './logger.js';
import { isProtectedQueue, PROTECTED_QUEUES } from './protected.js';

/** Prefixo do id gerado no worker quando o job não trouxe um (job antigo ou enfileirado pelo Next). */
export const WORKER_ID_PREFIX = 'wk-';

export interface CorrelatedJobLike {
  id?: string | null;
  opts?: { telemetry?: { metadata?: unknown } | undefined } | undefined;
}

interface QueueOptions {
  protectedQueues?: readonly string[];
  /** Id explícito; padrão: o do contexto atual (requisição da API). */
  correlationId?: string;
}

/**
 * Opts do `queue.add` com o id no metadata. Devolve `opts` SEM cópia quando a fila é protegida,
 * quando não há id (boot, cron) ou quando o chamador já definiu `telemetry`.
 */
export function correlationJobOptions<O extends object | undefined>(queue: string, opts: O, options: QueueOptions = {}): O {
  if (isProtectedQueue(queue, options.protectedQueues ?? PROTECTED_QUEUES)) return opts;
  const correlationId = options.correlationId ?? getCorrelationId();
  if (!correlationId) return opts;
  if (opts && 'telemetry' in opts && (opts as { telemetry?: unknown }).telemetry !== undefined) return opts;
  return { ...(opts ?? {}), telemetry: { metadata: `${JOB_METADATA_PREFIX}${correlationId}` } } as O;
}

/** Id gravado no metadata do job; ausente/malformado → null. */
export function parseJobCorrelationId(job: CorrelatedJobLike | undefined | null): string | null {
  const metadata = job?.opts?.telemetry?.metadata;
  if (typeof metadata !== 'string' || !metadata.startsWith(JOB_METADATA_PREFIX)) return null;
  return parseCorrelationId(metadata.slice(JOB_METADATA_PREFIX.length));
}

const assigned = new WeakMap<object, string>();

/** Id usado na execução do job (o do metadata, ou o `wk-<uuid>` gerado por `withCorrelation`). */
export function correlationIdOfJob(job: CorrelatedJobLike | undefined | null): string | null {
  if (!job) return null;
  return assigned.get(job) ?? parseJobCorrelationId(job);
}

export interface WithCorrelationOptions {
  queue: string;
  /** Logger base do worker; o processor loga por um filho sanitizado com `correlationId`. */
  logger?: unknown;
  protectedQueues?: readonly string[];
}

/**
 * Envolve o processor em contexto AsyncLocalStorage com o id do job. Fila protegida → devolve o
 * MESMO processor (sem wrapper). Nunca impede o job de rodar: id ausente/malformado → `wk-<uuid>`.
 */
export function withCorrelation<J extends CorrelatedJobLike, A extends unknown[], R>(
  processor: (job: J, ...rest: A) => R,
  options: WithCorrelationOptions,
): (job: J, ...rest: A) => R {
  if (isProtectedQueue(options.queue, options.protectedQueues ?? PROTECTED_QUEUES)) return processor;
  const template = options.logger ? createSanitizedLogger(options.logger as PinoLike) : undefined;
  return function correlated(job: J, ...rest: A): R {
    const correlationId = parseJobCorrelationId(job) ?? newCorrelationId(WORKER_ID_PREFIX);
    if (job && typeof job === 'object') assigned.set(job, correlationId);
    const logger = template && typeof template.child === 'function' ? template.child({ correlationId }) : undefined;
    return correlationStorage.run({ correlationId, ...(logger ? { logger } : {}) }, () => processor(job, ...rest));
  };
}

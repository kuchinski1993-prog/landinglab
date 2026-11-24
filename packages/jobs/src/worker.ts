// @blackshop/jobs/worker — durableProcessor: envolve um processor do BullMQ com o ledger.
//
// - begin(): novo lease_token, attempts + 1 (fencing: worker antigo não sobrescreve o novo);
// - handler ok → succeed(); handler lança → classifica, GRAVA e só então relança:
//     determinístico/incerto → UnrecoverableError (o BullMQ não repete);
//     transitório → o erro original (o BullMQ repete com o backoff da fila);
//     `failed` só no determinístico ou na última tentativa (RetryPolicy);
// - nunca lança sem registrar; nunca relança `undefined` (valores estranhos viram Error);
// - ledger fora: loga `job_ledger_write_failed` (queue, jobKey, op — sem payload) e NÃO muda
//   o desfecho do handler (o ledger nunca derruba o job nem o salva);
// - renova o lease sozinho a cada leaseMs/2 enquanto o handler roda (como o BullMQ faz com o
//   lock) e para no fim: "lease vencido" passa a significar "worker morreu" (o reserve reabre
//   órfãos). Se outro worker assumir (fencing), a renovação para.
import { UnrecoverableError } from 'bullmq';

import { classifyJobError, type ProcessorClassifier } from './classify.js';
import { JobThrewNonError } from './errors.js';
import { RetryPolicy, type AttemptInfo } from './retry-policy.js';
import { messageOf, sanitizeErrorText } from './sanitize.js';
import type { JobLease, JobRunStore } from './store-types.js';
import type { JobErrorClassification } from './types.js';

/**
 * Filas protegidas (CLAUDE.md raiz): NUNCA recebem wrapper, ledger nem o modo `finalStateOnly`
 * do job-logger. `durableProcessor` recusa essas filas na construção.
 */
export const PROTECTED_QUEUES: readonly string[] = ['email-queue', 'inbound-classify-queue', 'tracker-capi-queue'];

export function isProtectedQueue(queue: string): boolean {
  return PROTECTED_QUEUES.includes(queue);
}

/** Forma mínima do job do BullMQ usada pelo wrapper (permite job simulado nos testes). */
export interface DurableJob<D = unknown> extends AttemptInfo {
  id?: string | null;
  name: string;
  data: D;
}

export interface JobLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface DurableContext {
  /** Estende o lease (jobs longos). false = outro worker assumiu (pare de gravar efeitos). */
  heartbeat(): Promise<boolean>;
  /** Tentativa atual segundo o ledger (1-based); null se o ledger estiver fora. */
  attempt: number | null;
}

export interface DurableProcessorOptions<D, R> {
  queue: string;
  store: JobRunStore | (() => JobRunStore);
  /** Chave estável do ledger. Padrão: `job.id`. */
  keyOf?: (job: DurableJob<D>) => string;
  /** Duração do lease (use o lockDuration da fila). Padrão 30 s (default do BullMQ). */
  leaseMs?: number;
  /** Mapa do processor (decide antes das regras genéricas). */
  classify?: ProcessorClassifier;
  /** Resultado pequeno gravado em job_runs.result. Padrão: o retorno do handler. */
  resultOf?: (result: R) => unknown;
  storeIdOf?: (job: DurableJob<D>) => string | undefined;
  logger?: JobLogger;
}

export const DEFAULT_LEASE_MS = 30_000;

const consoleLogger: JobLogger = {
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

/** Erro relançado ao BullMQ quando não deve haver retry; preserva `code` (job-logger lê `errorCode`). */
export class DurableJobFailure extends UnrecoverableError {
  readonly code: string;
  readonly errorKind: JobErrorClassification['kind'];

  constructor(classification: JobErrorClassification, cause: unknown) {
    super(classification.message || classification.code);
    this.name = 'UnrecoverableError';
    this.code = classification.code;
    this.errorKind = classification.kind;
    (this as { cause?: unknown }).cause = cause;
  }
}

export function durableProcessor<D, R>(
  handler: (job: DurableJob<D>, ctx: DurableContext) => Promise<R>,
  options: DurableProcessorOptions<D, R>,
): (job: DurableJob<D>) => Promise<R> {
  if (isProtectedQueue(options.queue)) {
    throw new Error(`[@blackshop/jobs] a fila '${options.queue}' é protegida e não adota o ledger`);
  }
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const logger = options.logger ?? consoleLogger;
  const resolveStore = (): JobRunStore => (typeof options.store === 'function' ? options.store() : options.store);

  return async function durable(job: DurableJob<D>): Promise<R> {
    const jobKey = options.keyOf ? options.keyOf(job) : String(job.id ?? 'unknown');
    const key = { queue: options.queue, jobKey };
    const ledgerFailed = (op: string, err: unknown): void => {
      logger.error(
        { queue: options.queue, jobKey, op, error: sanitizeErrorText(messageOf(err), 200) },
        'job_ledger_write_failed',
      );
    };

    let store: JobRunStore | null = null;
    let lease: JobLease | null = null;
    try {
      store = resolveStore();
      const storeId = options.storeIdOf?.(job);
      lease = await store.begin({
        ...key,
        leaseMs,
        maxAttempts: RetryPolicy.maxAttemptsOf(job),
        jobName: job.name,
        ...(storeId ? { storeId } : {}),
      });
    } catch (err) {
      ledgerFailed('begin', err);
    }

    let leaseLost = false;
    const heartbeat = async (): Promise<boolean> => {
      if (!store || !lease) return true;
      if (leaseLost) return false;
      try {
        const ok = await store.heartbeat(lease, leaseMs);
        if (!ok) leaseLost = true;
        return ok;
      } catch (err) {
        ledgerFailed('heartbeat', err);
        return true;
      }
    };
    const ctx: DurableContext = { attempt: lease?.attempts ?? null, heartbeat };

    // Renovação automática do lease (QA REL-001). Uma renovação por vez; o stop espera a que
    // estiver em andamento (QA TEST-001) — succeed/fail nunca disputam a conexão com ela e a
    // ordem das escritas fica determinística em qualquer driver.
    let renewal: ReturnType<typeof setInterval> | null = null;
    let inFlight: Promise<void> | null = null;
    if (store && lease) {
      renewal = setInterval(() => {
        if (inFlight) return;
        inFlight = heartbeat()
          .then((ok) => {
            if (!ok && renewal) {
              clearInterval(renewal);
              renewal = null;
              logger.warn({ queue: options.queue, jobKey, op: 'heartbeat' }, 'job_ledger_lease_lost');
            }
          })
          .finally(() => {
            inFlight = null;
          });
      }, Math.max(1, Math.floor(leaseMs / 2)));
      renewal.unref?.();
    }
    const stopRenewal = async (): Promise<void> => {
      if (renewal) clearInterval(renewal);
      renewal = null;
      if (inFlight) await inFlight;
    };

    let result: R;
    try {
      result = await handler(job, ctx);
    } catch (thrown) {
      await stopRenewal();
      const classification = classifyJobError(thrown, { classify: options.classify });
      const decision = RetryPolicy.decide(classification.kind, RetryPolicy.isLastAttempt(job));
      if (store && lease) {
        try {
          const written = await store.fail(lease, {
            state: decision.state,
            errorKind: classification.kind,
            errorCode: classification.code,
            lastError: classification.message,
          });
          if (!written) logger.warn({ queue: options.queue, jobKey, op: 'fail' }, 'job_ledger_lease_lost');
        } catch (err) {
          ledgerFailed('fail', err);
        }
      }
      if (classification.kind !== 'transient') throw new DurableJobFailure(classification, thrown);
      throw thrown instanceof Error ? thrown : new JobThrewNonError(thrown);
    }
    await stopRenewal();

    if (store && lease) {
      try {
        const payload = options.resultOf ? options.resultOf(result) : result;
        const written = await store.succeed(lease, payload);
        if (!written) logger.warn({ queue: options.queue, jobKey, op: 'succeed' }, 'job_ledger_lease_lost');
      } catch (err) {
        ledgerFailed('succeed', err);
      }
    }
    return result;
  };
}

/**
 * Regra do `finalStateOnly` do job-logger (mesma do ledger): a falha é FINAL quando o erro não
 * será repetido pelo BullMQ — UnrecoverableError ou última tentativa. No evento `failed` do
 * BullMQ o `attemptsMade` já inclui a tentativa que acabou de falhar.
 */
export function isFinalFailureEvent(job: AttemptInfo | undefined, err: unknown): boolean {
  // Sem job ou sem contagem de tentativas: trata como final (mantém o comportamento antigo).
  if (!job || typeof job.attemptsMade !== 'number') return true;
  if (err instanceof UnrecoverableError || (err as { name?: unknown } | null)?.name === 'UnrecoverableError') return true;
  return job.attemptsMade >= RetryPolicy.maxAttemptsOf(job);
}

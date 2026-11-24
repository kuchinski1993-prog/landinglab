// @blackshop/jobs/producer — enqueue durável e reconciliação de enfileiramentos falhos.
//
// enqueueDurable: grava job_runs (`queued`) ANTES do queue.add. Idempotente por jobKey: com a
// linha viva (queued/running/retrying), não cria outro job. Se o add lançar (Redis fora), a linha
// vai para `queued_failed` (plataforma.job_enqueue_failed) e lança JobEnqueueError (503 tipado).
// Se o próprio ledger estiver fora, loga `job_ledger_write_failed` e enfileira assim mesmo
// (o ledger nunca impede o trabalho de acontecer).
//
// O jobId do BullMQ NÃO é o jobKey: depois de concluído, o BullMQ guarda o job (removeOnComplete
// 24 h) e um add com o mesmo id seria ignorado em silêncio. Cada (re)enfileiramento usa
// `${jobKey}:${Date.now()}` (formato `a:b:c` aceito pelo BullMQ); a deduplicação é do ledger.
import { JobEnqueueError } from './errors.js';
import { messageOf, sanitizeErrorText } from './sanitize.js';
import type { JobRunStore } from './store-types.js';
import type { JobRun } from './types.js';
import type { JobLogger } from './worker.js';

/** Quem enfileira de fato (BullMQ `Queue.add` ou o `fastify.queue.enqueue` da API). */
export type EnqueueFn = (
  jobName: string,
  data: unknown,
  opts: { jobId: string },
) => Promise<{ id?: string | null } | unknown>;

export interface EnqueueDurableInput {
  queue: string;
  jobKey: string;
  jobName: string;
  data: unknown;
  maxAttempts?: number;
  storeId?: string;
  correlationId?: string;
  /** Flags mínimas guardadas no ledger para o reconcile reconstruir o job (nunca dados do cliente). */
  replay?: Record<string, unknown>;
}

export interface EnqueueDurableResult {
  /** true = enfileirado agora; false = já havia execução viva com este jobKey (nada feito). */
  enqueued: boolean;
  /** jobId usado no BullMQ (null quando não enfileirou). */
  jobId: string | null;
  /** false = ledger indisponível (enfileirou sem registro). */
  ledger: boolean;
  run: JobRun | null;
}

export interface EnqueueDurableOptions {
  logger?: JobLogger;
  /** Gera o jobId do BullMQ (testes). */
  jobIdOf?: (jobKey: string) => string;
}

const ENQUEUE_FAILED = 'plataforma.job_enqueue_failed';

/**
 * jobId do BullMQ: `${jobKey}:${Date.now()}`. O BullMQ só aceita ':' no formato de 3 partes
 * (`a:b:c`); `relink:<productId>` vira `relink:<productId>:<ts>` (mesmo formato de antes).
 * jobKey com outra quantidade de ':' tem os ':' trocados por '_'.
 */
export function defaultJobId(jobKey: string, now = Date.now()): string {
  const base = jobKey.split(':').length === 2 ? jobKey : jobKey.replace(/:/g, '_');
  return base.includes(':') ? `${base}:${now}` : `${base}:run:${now}`;
}

export async function enqueueDurable(
  store: JobRunStore,
  enqueue: EnqueueFn,
  input: EnqueueDurableInput,
  options: EnqueueDurableOptions = {},
): Promise<EnqueueDurableResult> {
  const logger = options.logger;
  const key = { queue: input.queue, jobKey: input.jobKey };
  let run: JobRun | null = null;
  let ledger = true;
  try {
    const reservation = await store.reserve({
      ...key,
      jobName: input.jobName,
      maxAttempts: input.maxAttempts ?? 3,
      ...(input.storeId ? { storeId: input.storeId } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.replay ? { replay: input.replay } : {}),
    });
    run = reservation.run;
    if (!reservation.reserved) return { enqueued: false, jobId: null, ledger: true, run };
  } catch (err) {
    ledger = false;
    logger?.error(
      { queue: input.queue, jobKey: input.jobKey, op: 'reserve', error: sanitizeErrorText(messageOf(err), 200) },
      'job_ledger_write_failed',
    );
  }

  const jobId = (options.jobIdOf ?? defaultJobId)(input.jobKey);
  try {
    await enqueue(input.jobName, input.data, { jobId });
  } catch (err) {
    if (ledger) {
      try {
        await store.markQueuedFailed(key, {
          errorCode: ENQUEUE_FAILED,
          lastError: sanitizeErrorText(messageOf(err)),
        });
      } catch (markErr) {
        logger?.error(
          { queue: input.queue, jobKey: input.jobKey, op: 'markQueuedFailed', error: sanitizeErrorText(messageOf(markErr), 200) },
          'job_ledger_write_failed',
        );
      }
    }
    throw new JobEnqueueError(key, err);
  }
  return { enqueued: true, jobId, ledger, run };
}

export interface ReconcileOptions {
  /** Padrão true: só lista o que seria re-enfileirado. */
  dryRun?: boolean;
  queue?: string;
  limit?: number;
  logger?: JobLogger;
  jobIdOf?: (jobKey: string) => string;
}

export interface ReconcileReport {
  dryRun: boolean;
  candidates: Array<{ queue: string; jobKey: string; jobName: string | null; errorCode: string | null }>;
  requeued: number;
  failed: number;
}

/**
 * Re-enfileira as linhas `queued_failed`. Os dados do job vêm de `dataOf(run)` (o ledger não
 * guarda payload); `null` pula a linha. Em dry-run (padrão) não altera nada.
 */
export async function reconcileQueuedFailed(
  store: JobRunStore,
  enqueueFor: (queue: string) => EnqueueFn,
  dataOf: (run: JobRun) => unknown | null,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const dryRun = options.dryRun ?? true;
  const rows = await store.list({
    states: ['queued_failed'],
    ...(options.queue ? { queue: options.queue } : {}),
    limit: options.limit ?? 500,
  });
  const report: ReconcileReport = {
    dryRun,
    candidates: rows.map((row) => ({ queue: row.queue, jobKey: row.jobKey, jobName: row.jobName, errorCode: row.errorCode })),
    requeued: 0,
    failed: 0,
  };
  if (dryRun) return report;
  for (const row of rows) {
    const data = dataOf(row);
    if (data === null) continue;
    try {
      const result = await enqueueDurable(
        store,
        enqueueFor(row.queue),
        {
          queue: row.queue,
          jobKey: row.jobKey,
          jobName: row.jobName ?? row.queue,
          data,
          maxAttempts: row.maxAttempts,
          storeId: row.storeId,
          ...(row.replay ? { replay: row.replay } : {}),
        },
        { ...(options.logger ? { logger: options.logger } : {}), ...(options.jobIdOf ? { jobIdOf: options.jobIdOf } : {}) },
      );
      if (result.enqueued) report.requeued += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}


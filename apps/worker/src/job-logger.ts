// Structured job logging to Postgres. Listens to BullMQ Worker events and writes
// a row to job_logs for each completion / failure, with duration metrics.
import { jobLogs, jobs, type Database } from '@blackshop/db';
import { isFinalFailureEvent, isProtectedQueue } from '@blackshop/jobs/worker';
import { correlationIdOfJob } from '@blackshop/observability/bullmq';
import { eq } from 'drizzle-orm';
import type { Job, Worker } from 'bullmq';

import type { QueueName } from './config.js';
import { logger } from './logger.js';
import { workerMetrics } from './metrics-publisher.js';

export interface JobLoggerOptions {
  db: Database;
  worker: Pick<Worker, 'on'>;
  // Relaxado pra string em SM-6.4 pra suportar queues dedicados fora do
  // enum QUEUE_NAMES (kill-switch-*-phase2). Todos os callers ainda passam
  // strings estáveis; o valor só vira campo em data JSON do job_logs.
  queue: QueueName | string;
  /**
   * Story 18.3 · opt-in: falha que o BullMQ ainda vai repetir NÃO marca `jobs.status = 'failed'`
   * nem grava "job failed" — grava `warn` "job attempt failed (n/N)" e mantém o status. Só a
   * última tentativa (ou UnrecoverableError) marca failed. Ignorado nas filas protegidas
   * (email-queue, inbound-classify-queue, tracker-capi-queue), que mantêm o comportamento atual.
   */
  finalStateOnly?: boolean;
}

function durationMs(job: Pick<Job, 'processedOn'>): number {
  const processedOn = job.processedOn ?? Date.now();
  return Date.now() - processedOn;
}

async function insertLog(
  db: Database,
  row: {
    jobId: string;
    level: 'info' | 'warn' | 'error';
    message: string;
    data: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await db.insert(jobLogs).values({
      jobId: row.jobId,
      level: row.level,
      message: row.message,
      data: row.data,
    });
  } catch (err) {
    // Never let a logging failure crash a worker.
    logger.error({ err, jobId: row.jobId }, 'failed to persist job log');
  }
}

async function updateJobStatus(
  db: Database,
  jobId: string,
  status: 'completed' | 'failed',
  returnValue?: unknown,
): Promise<void> {
  try {
    const update: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === 'completed' && returnValue !== undefined) {
      update['result'] = returnValue as Record<string, unknown>;
    }
    await db.update(jobs).set(update).where(eq(jobs.id, jobId));
  } catch (err) {
    logger.error({ err, jobId }, 'failed to update job status');
  }
}

function errorCodeOf(err: Error): { errorCode?: string } {
  const code: unknown = (err as unknown as { code?: unknown }).code;
  return typeof code === 'string' ? { errorCode: code } : {};
}

/**
 * Story 18.4 · só filas NÃO protegidas: `data.correlationId` (o id da execução — metadata do job
 * ou o `wk-<uuid>` do withCorrelation) e as métricas job_duration_ms / job_failures_total.
 * Filas protegidas gravam exatamente o que gravavam antes.
 */
function correlationOf(observed: boolean, job: Job | undefined): { correlationId?: string } {
  if (!observed) return {};
  const correlationId = correlationIdOfJob(job);
  return correlationId ? { correlationId } : {};
}

function recordJobMetrics(queue: string, duration: number, failed: { errorCode?: string } | null): void {
  try {
    workerMetrics.observe('job_duration_ms', { queue }, duration);
    if (failed) workerMetrics.inc('job_failures_total', { queue, error_code: failed.errorCode ?? 'unknown' });
  } catch {
    // Métrica nunca afeta o job.
  }
}

export function attachJobLogger(options: JobLoggerOptions): void {
  const { db, worker, queue } = options;
  const finalStateOnly = options.finalStateOnly === true && !isProtectedQueue(queue);
  const observed = !isProtectedQueue(queue);

  worker.on('completed', (job: Job) => {
    const jobId = String(job.id ?? 'unknown');
    const duration = durationMs(job);
    if (observed) recordJobMetrics(queue, duration, null);
    void insertLog(db, {
      jobId,
      level: 'info',
      message: 'job completed',
      data: {
        durationMs: duration,
        queue,
        type: job.name,
        status: 'completed',
        ...correlationOf(observed, job),
      },
    });
    void updateJobStatus(db, jobId, 'completed', job.returnvalue);
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    const jobId = job?.id != null ? String(job.id) : 'unknown';
    if (finalStateOnly && !isFinalFailureEvent(job, err)) {
      const attempts = job?.opts?.attempts ?? 1;
      void insertLog(db, {
        jobId,
        level: 'warn',
        message: `job attempt failed (${job?.attemptsMade ?? 0}/${attempts})`,
        data: {
          durationMs: job ? durationMs(job) : 0,
          queue,
          type: job?.name ?? 'unknown',
          status: 'retrying',
          attempt: job?.attemptsMade ?? 0,
          maxAttempts: attempts,
          error: err.message,
          ...errorCodeOf(err),
          ...correlationOf(observed, job),
        },
      });
      return;
    }
    const duration = job ? durationMs(job) : 0;
    if (observed) recordJobMetrics(queue, duration, errorCodeOf(err));
    void insertLog(db, {
      jobId,
      level: 'error',
      message: 'job failed',
      data: {
        durationMs: duration,
        queue,
        type: job?.name ?? 'unknown',
        status: 'failed',
        error: err.message,
        // Story 0.8: código estável quando o erro é classificado (ex.: UPSTREAM_TIMEOUT).
        ...errorCodeOf(err),
        ...correlationOf(observed, job),
      },
    });
    void updateJobStatus(db, jobId, 'failed');
  });
}

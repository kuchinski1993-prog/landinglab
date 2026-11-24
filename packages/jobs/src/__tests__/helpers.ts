// Job simulado com a mesma regra de retry do BullMQ 5 (Job.shouldRetryJob): repete enquanto
// `attemptsMade + 1 < attempts` e o erro não é UnrecoverableError. Sem Redis.
import { UnrecoverableError } from 'bullmq';

import type { DurableJob } from '../worker.js';

export interface SimulatedRun<R> {
  outcome: 'completed' | 'failed';
  result?: R;
  error?: unknown;
  /** Erro lançado em cada execução (undefined = sucesso). */
  errors: unknown[];
  executions: number;
}

export async function runLikeBullMQ<D, R>(
  processor: (job: DurableJob<D>) => Promise<R>,
  data: D,
  options: { attempts?: number; id?: string; name?: string } = {},
): Promise<SimulatedRun<R>> {
  const job: DurableJob<D> = {
    id: options.id ?? 'job-1',
    name: options.name ?? 'TestJob',
    data,
    attemptsMade: 0,
    opts: { attempts: options.attempts ?? 3 },
  };
  const errors: unknown[] = [];
  for (;;) {
    try {
      const result = await processor(job);
      errors.push(undefined);
      return { outcome: 'completed', result, errors, executions: errors.length };
    } catch (err) {
      errors.push(err);
      const unrecoverable = err instanceof UnrecoverableError || (err as Error)?.name === 'UnrecoverableError';
      if (unrecoverable || job.attemptsMade + 1 >= (job.opts?.attempts ?? 1)) {
        return { outcome: 'failed', error: err, errors, executions: errors.length };
      }
      job.attemptsMade += 1;
    }
  }
}

export const silentLogger = () => {
  const entries: Array<{ level: 'warn' | 'error'; msg: string; obj: Record<string, unknown> }> = [];
  return {
    entries,
    warn: (obj: Record<string, unknown>, msg: string) => void entries.push({ level: 'warn', msg, obj }),
    error: (obj: Record<string, unknown>, msg: string) => void entries.push({ level: 'error', msg, obj }),
  };
};

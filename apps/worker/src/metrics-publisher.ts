// Story 18.4 · Métricas do worker (D-18.1: em memória, sem serviço novo).
// - workerMetrics: job_duration_ms{queue} e job_failures_total{queue,error_code} (job-logger);
// - a cada `intervalMs` lê getJobCounts() das filas NÃO protegidas (jobs_by_state{queue,state})
//   e publica o snapshot em `worker:metrics` (TTL 60 s), lido por GET /admin/metrics na API —
//   mesmo padrão do `worker:heartbeat`;
// - linha `metrics_snapshot` a cada 60 s. Tudo no timer; nada no caminho do job.
import { createMetricsRegistry, isProtectedQueue, startSnapshotLog, type MetricsRegistry, type SnapshotLogHandle } from '@blackshop/observability';
import type { Redis } from 'ioredis';

import { rootLogger } from './logger.js';

export const WORKER_METRICS_KEY = 'worker:metrics';
export const WORKER_METRICS_TTL_SECONDS = 60;
export const WORKER_METRICS_INTERVAL_MS = 30_000;
const COUNTS_TIMEOUT_MS = 5_000;
export const JOB_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'] as const;

/** Registro do processo do worker. */
export const workerMetrics: MetricsRegistry = createMetricsRegistry();

export interface CountableQueue {
  getJobCounts(...states: string[]): Promise<Record<string, number>>;
  close?: () => Promise<void>;
}

export interface MetricsPublisherOptions {
  redis: Pick<Redis, 'setex'>;
  /** Nomes das filas; as protegidas são ignoradas. */
  queueNames: readonly string[];
  /** Cria (uma vez, no primeiro tick) o objeto que responde getJobCounts. */
  queueFactory: (name: string) => CountableQueue;
  registry?: MetricsRegistry;
  intervalMs?: number;
  ttlSeconds?: number;
  snapshotLogIntervalMs?: number;
  logger?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
}

export interface MetricsPublisherHandle {
  /** Um ciclo (testes): conta filas, publica no Redis. Nunca lança. */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function startMetricsPublisher(options: MetricsPublisherOptions): MetricsPublisherHandle {
  const registry = options.registry ?? workerMetrics;
  const logger = options.logger ?? rootLogger;
  const names = options.queueNames.filter((name) => !isProtectedQueue(name));
  const ttl = options.ttlSeconds ?? WORKER_METRICS_TTL_SECONDS;
  let queues: Map<string, CountableQueue> | null = null;
  let lastQueues: Record<string, unknown> = { error: 'indisponível' };

  const tick = async (): Promise<void> => {
    try {
      queues ??= new Map(names.map((name) => [name, options.queueFactory(name)]));
      const results = await Promise.allSettled(
        [...queues].map(async ([name, queue]) => [name, await withTimeout(queue.getJobCounts(...JOB_STATES), COUNTS_TIMEOUT_MS)] as const),
      );
      const counts: Record<string, Record<string, number>> = {};
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const [name, byState] = result.value;
        counts[name] = byState;
        for (const state of JOB_STATES) registry.set('jobs_by_state', { queue: name, state }, byState[state] ?? 0);
      }
      lastQueues = Object.keys(counts).length > 0 ? counts : { error: 'indisponível' };
      const payload = JSON.stringify({ generatedAt: new Date().toISOString(), metrics: registry.snapshot(), queues: lastQueues });
      await options.redis.setex(WORKER_METRICS_KEY, ttl, payload);
    } catch (err) {
      logger.warn({ errName: (err as Error | undefined)?.name }, 'worker metrics publish failed');
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? WORKER_METRICS_INTERVAL_MS);
  timer.unref?.();
  const snapshotLog: SnapshotLogHandle = startSnapshotLog(registry, logger, {
    ...(options.snapshotLogIntervalMs ? { intervalMs: options.snapshotLogIntervalMs } : {}),
    extra: () => ({ queues: lastQueues }),
  });

  return {
    tick,
    async stop() {
      clearInterval(timer);
      snapshotLog.stop();
      if (queues) await Promise.allSettled([...queues.values()].map((q) => q.close?.()));
    },
  };
}

// Graceful shutdown coordinator. Registers SIGTERM/SIGINT handlers, drains all
// BullMQ Workers, then exits. A 10s timer forces exit(1) if anything hangs.
import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { SHUTDOWN_TIMEOUT_MS } from './config.js';
import type { HeartbeatHandle } from './heartbeat.js';
import { logger } from './logger.js';

export interface ShutdownResources {
  workers: Worker[];
  heartbeat: HeartbeatHandle;
  redis: Pick<Redis, 'quit' | 'disconnect'>;
  db?: { sql: { end: (opts?: { timeout?: number }) => Promise<void> } };
  extraClosers?: Array<() => Promise<void>>;
}

export interface RegisterShutdownOptions {
  timeoutMs?: number;
  exit?: (code: number) => void;
  signals?: NodeJS.Signals[];
}

export async function shutdown(
  resources: ShutdownResources,
  opts: { timeoutMs?: number; exit?: (code: number) => void } = {}
): Promise<void> {
  const { timeoutMs = SHUTDOWN_TIMEOUT_MS, exit = process.exit.bind(process) } = opts;

  logger.info('shutdown: starting graceful drain');

  const forceTimer = setTimeout(() => {
    logger.error({ timeoutMs }, 'shutdown: timeout exceeded, forcing exit(1)');
    exit(1);
  }, timeoutMs);
  forceTimer.unref?.();

  try {
    resources.heartbeat.stop();

    await Promise.all(
      resources.workers.map((worker) =>
        worker.close().catch((err: unknown) => {
          logger.error({ err }, 'shutdown: worker close failed');
        })
      )
    );

    await Promise.all(
      (resources.extraClosers ?? []).map((close) =>
        close().catch((err: unknown) => {
          logger.error({ err }, 'shutdown: additional runtime close failed');
        })
      )
    );

    if (resources.db) {
      await resources.db.sql.end({ timeout: 5 }).catch((err: unknown) => {
        logger.error({ err }, 'shutdown: db close failed');
      });
    }

    await Promise.resolve(resources.redis.quit()).catch(() => {
      resources.redis.disconnect();
    });

    clearTimeout(forceTimer);
    logger.info('shutdown: graceful drain complete');
    exit(0);
  } catch (err) {
    clearTimeout(forceTimer);
    logger.error({ err }, 'shutdown: failure during drain');
    exit(1);
  }
}

export function registerShutdownHandlers(
  resources: ShutdownResources,
  opts: RegisterShutdownOptions = {}
): () => void {
  const signals: NodeJS.Signals[] = opts.signals ?? ['SIGTERM', 'SIGINT'];
  let triggered = false;

  const handler = (signal: NodeJS.Signals) => (): void => {
    if (triggered) return;
    triggered = true;
    logger.info({ signal }, 'shutdown signal received');
    void shutdown(resources, { timeoutMs: opts.timeoutMs, exit: opts.exit });
  };

  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const sig of signals) {
    const fn = handler(sig);
    listeners.set(sig, fn);
    process.on(sig, fn);
  }

  return (): void => {
    for (const [sig, fn] of listeners) {
      process.off(sig, fn);
    }
  };
}

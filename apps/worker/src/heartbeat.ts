// Redis heartbeat: writes a TTL'd key every 25s. If the worker dies, the key
// expires within 30s and the API health check reports `worker: "offline"`.
import type { Redis } from 'ioredis';

import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_KEY, HEARTBEAT_TTL_SECONDS } from './config.js';
import { logger } from './logger.js';

export interface HeartbeatHandle {
  stop: () => void;
}

export interface StartHeartbeatOptions {
  redis: Pick<Redis, 'setex'>;
  intervalMs?: number;
  ttlSeconds?: number;
  key?: string;
  /** When true, fires once immediately before scheduling the interval. */
  fireImmediately?: boolean;
  /**
   * Story 0.4: quando presente, cada tick também grava `modes.key` (mesmo TTL) com o JSON
   * dos modos das integrações do worker, lido pelo GET /health da API. `worker:heartbeat`
   * continua com o valor fixo 'alive'.
   */
  modes?: { key: string; payload: () => string };
}

export function startHeartbeat(options: StartHeartbeatOptions): HeartbeatHandle {
  const {
    redis,
    intervalMs = HEARTBEAT_INTERVAL_MS,
    ttlSeconds = HEARTBEAT_TTL_SECONDS,
    key = HEARTBEAT_KEY,
    fireImmediately = true,
    modes,
  } = options;

  const tick = (): void => {
    void Promise.resolve(redis.setex(key, ttlSeconds, 'alive')).catch((err: unknown) => {
      logger.error({ err }, 'heartbeat write failed');
    });
    if (modes) {
      void Promise.resolve()
        .then(() => redis.setex(modes.key, ttlSeconds, modes.payload()))
        .catch((err: unknown) => {
          logger.error({ err }, 'worker modes write failed');
        });
    }
  };

  if (fireImmediately) {
    tick();
  }

  const handle = setInterval(tick, intervalMs);
  // Don't block process exit if interval is somehow the only thing left.
  handle.unref?.();

  return {
    stop: (): void => {
      clearInterval(handle);
    },
  };
}

// Bootstrap do worker LandingLab. Uma conexão ioredis compartilhada por todos os Workers BullMQ,
// processors das filas LandingLab com a concorrência de `config.ts`, log dos jobs no Postgres
// e heartbeat no Redis.
import { createClient, type Database } from '@blackshop/db';
import { withCorrelation } from '@blackshop/observability/bullmq';
import { Queue, Worker, type Processor } from 'bullmq';
import { Redis as IORedis, type Redis } from 'ioredis';

import {
  jobOptionsFor,
  QUEUE_CONCURRENCY,
  QUEUE_LIMITER,
  QUEUE_LOCK_DURATION,
  QUEUE_NAMES,
  loadConfig,
  type QueueName,
  type WorkerConfig,
} from './config.js';
import { startHeartbeat, type HeartbeatHandle } from './heartbeat.js';
import { attachJobLogger } from './job-logger.js';
import { WORKER_MODES_KEY, logWorkerIntegrationModes, workerModesPayload } from './lib/integration-mode.js';
import { logger, rootLogger } from './logger.js';
import { startMetricsPublisher, type MetricsPublisherHandle } from './metrics-publisher.js';
import { processApplyBundle } from './processors/landinglab-apply-bundle.processor.js';
import {
  createProductionDeps as createLandingLabBuildDeps,
  makeLandingLabBuildProcessor,
} from './processors/landinglab-build.processor.js';
import { processLandingLabClone } from './processors/landinglab-clone.processor.js';
import {
  createProductionDeps as createLandingLabCopyDeps,
  makeLandingLabCopyProcessor,
} from './processors/landinglab-copy.processor.js';
import {
  createProductionDeps as createLandingLabDeployDeps,
  makeLandingLabDeployProcessor,
} from './processors/landinglab-deploy.processor.js';
import { processLandingExport } from './processors/landinglab-export.processor.js';
import { processImageMetadataJob } from './processors/landinglab-image-metadata.processor.js';
import {
  createProductionDeps as createLandingLabResearchDeps,
  makeLandingLabResearchProcessor,
} from './processors/landinglab-research.processor.js';
import { processLandingLabTranslateImages } from './processors/landinglab-translate-images.processor.js';
import { processLandingLabTranslateText } from './processors/landinglab-translate-text.processor.js';
import {
  createProductionDeps as createLandingLabVisualDeps,
  makeLandingLabVisualProcessor,
} from './processors/landinglab-visual.processor.js';
import type { ShutdownResources } from './shutdown.js';

export interface WorkerRuntime {
  workers: Worker[];
  redis: Redis;
  db: ReturnType<typeof createClient>;
  heartbeat: HeartbeatHandle;
  config: WorkerConfig;
  metricsPublisher: MetricsPublisherHandle;
}

/** Processor em contexto de correlação (id do job → logs e job_logs). */
export function correlatedProcessor(queue: string, processor: Processor): Processor {
  return withCorrelation(processor, { queue, logger: rootLogger });
}

export interface StartWorkerOptions {
  config?: WorkerConfig;
  /** Test seam: ioredis falso. */
  redisFactory?: (url: string) => Redis;
  /** Test seam: cliente de banco falso. */
  dbFactory?: () => { db: Database; sql: { end: (opts?: { timeout?: number }) => Promise<void> } };
  heartbeatFireImmediately?: boolean;
}

function createRedisConnection(url: string): Redis {
  // O BullMQ exige maxRetriesPerRequest: null nas conexões de Worker.
  return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export async function startWorker(options: StartWorkerOptions = {}): Promise<WorkerRuntime> {
  const config = options.config ?? loadConfig();
  const redis = (options.redisFactory ?? createRedisConnection)(config.redisUrl);
  redis.on('error', (err: Error) => {
    logger.error({ err }, 'redis connection error');
  });

  const dbBundle = options.dbFactory ? options.dbFactory() : createClient({ databaseUrl: config.databaseUrl });

  const PROCESSORS: Record<QueueName, Processor> = {
    // Clonar: Playwright + download dos assets → bucket `cloned-landings` → UPDATE landing_pages.
    'landinglab.squad0.clone': processLandingLabClone as Processor,
    'landinglab.apply-bundle': processApplyBundle as Processor,
    'landinglab.image-metadata': processImageMetadataJob as Processor,
    'landinglab.translate-text': processLandingLabTranslateText as Processor,
    'landinglab.translate-images': processLandingLabTranslateImages as Processor,
    'landinglab.export': processLandingExport as Processor,
    // Gerar do zero: cada squad enfileira o próximo (research → copy → design → build).
    // O deploy (squad 5) é disparado pelo botão Publicar no backoffice.
    'landinglab.squad1.research': makeLandingLabResearchProcessor(createLandingLabResearchDeps()) as Processor,
    'landinglab.squad2.copy': makeLandingLabCopyProcessor(createLandingLabCopyDeps()) as Processor,
    'landinglab.squad3.design': makeLandingLabVisualProcessor(createLandingLabVisualDeps()) as Processor,
    'landinglab.squad4.build': makeLandingLabBuildProcessor(createLandingLabBuildDeps()) as Processor,
    'landinglab.squad5.deploy': makeLandingLabDeployProcessor(createLandingLabDeployDeps()) as Processor,
  };

  const workers: Worker[] = QUEUE_NAMES.map((name) => {
    const limiter = QUEUE_LIMITER[name];
    const lockDuration = QUEUE_LOCK_DURATION[name];
    const worker = new Worker(name, correlatedProcessor(name, PROCESSORS[name]), {
      connection: redis,
      concurrency: QUEUE_CONCURRENCY[name],
      ...(limiter ? { limiter } : {}),
      ...(lockDuration ? { lockDuration } : {}),
      ...({ defaultJobOptions: jobOptionsFor(name) } as Record<string, unknown>),
    });
    worker.on('error', (err: Error) => {
      logger.error({ err, queue: name }, 'worker error');
    });
    // "failed" só na última tentativa.
    attachJobLogger({ db: dbBundle.db, worker, queue: name, finalStateOnly: true });
    logger.info({ queue: name, concurrency: QUEUE_CONCURRENCY[name] }, 'worker registered');
    return worker;
  });

  logWorkerIntegrationModes();
  const heartbeat = startHeartbeat({
    redis,
    fireImmediately: options.heartbeatFireImmediately ?? true,
    modes: { key: WORKER_MODES_KEY, payload: () => workerModesPayload() },
  });

  const metricsPublisher = startMetricsPublisher({
    redis,
    queueNames: [...QUEUE_NAMES],
    queueFactory: (name) => new Queue(name, { connection: redis }),
  });

  logger.info({ queues: QUEUE_NAMES, redisUrl: config.redisUrl.replace(/:[^:@]*@/, ':***@') }, 'worker started');

  return { workers, redis, db: dbBundle as ReturnType<typeof createClient>, heartbeat, config, metricsPublisher };
}

export function toShutdownResources(runtime: WorkerRuntime): ShutdownResources {
  return {
    workers: runtime.workers,
    heartbeat: {
      stop: () => {
        runtime.heartbeat.stop();
        void runtime.metricsPublisher.stop();
      },
    },
    redis: runtime.redis,
    db: { sql: runtime.db.sql },
  };
}

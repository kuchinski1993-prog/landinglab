// BullMQ producer plugin — exposes typed enqueue helper for all routes.
import { correlationJobOptions } from '@blackshop/observability/bullmq';
import { vslRedisConnection } from '@blackshop/vsl-hosting';
import { Queue } from 'bullmq';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { QueueName, QueueProducer } from '../types.js';

// Filas VSL legacy: só existem com VSL_LEGACY_ENABLED=true e vivem no Redis
// dedicado (VSL_REDIS_URL) — o mesmo que o worker consome. Nunca no Redis principal.
export const VSL_LEGACY_QUEUES = ['vsl-video-reconcile', 'vsl-import'] as const satisfies readonly QueueName[];

const QUEUE_NAMES: readonly QueueName[] = [
  'import-queue',
  'import-group-queue',
  'image-queue',
  'publish-queue',
  'factory-queue',
  // Email queue — emails são enfileirados pelo api (gatilhos de refund, etc.)
  // e consumidos pelo worker via send-email.processor.
  'email-queue',
  // Inbound classify queue (Fase 4+5) — cada email recebido em
  // /webhooks/email/inbound dispara classificação IA + decisão no worker.
  'inbound-classify-queue',
  // Fase 2 Bloco 3.1 — sync automático de preço multi-moeda: gatilhado no
  // PATCH /products/:id quando o preço muda, e pelo refresh-fx via cron.
  'price-sync-queue',
  // Fase 2 Bloco 3.1 — bootstrap manual do refresh-fx via
  // POST /admin/fx/refresh (cron principal fica no worker).
  'refresh-fx-queue',
  // Jul/2026 — backfill de ligação variante↔imagem (POST /admin/publish/relink-colors-all).
  'relink-colors-queue',
  // Jul/2026 — corrige mirror_variant_id embaralhado
  // (POST /admin/publish/rewire-mirror-variants).
  'rewire-mirror-queue',
  // Jul/2026 — corrige variante ↔ imagem no Shopify
  // (POST /admin/publish/rewire-variant-media).
  'rewire-variant-media-queue',
  // Story 18.8 — envio de eventos do Marketing à Meta (Purchase Stripe, Lead, /tracking/event).
  // Job durável: attempts/backoff vão na chamada (6 tentativas, base 30 s), não no default.
  'marketing-capi-queue',
  // Story 24.4 — envio dos itens dos catálogos Meta pela Catalog API (job durável, 5 tentativas).
  'meta-catalog-push-queue',
] as const;

// Retry policy aligned with worker (Story 1.3 AC 5): 3 attempts, exponential backoff, 1s base delay.
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** Decide quais filas VSL criar e onde (exportado para teste). */
export function vslQueuePlan(config: { vslLegacyEnabled: boolean; vslRedisUrl: string | null }):
  { create: false; reason: 'legacy_disabled' | 'redis_missing' } | { create: true; connection: ReturnType<typeof vslRedisConnection> } {
  if (!config.vslLegacyEnabled) return { create: false, reason: 'legacy_disabled' };
  if (!config.vslRedisUrl) return { create: false, reason: 'redis_missing' };
  return { create: true, connection: vslRedisConnection(config.vslRedisUrl) };
}

const queuePlugin: FastifyPluginAsync = async (fastify) => {
  const queues = Object.fromEntries(
    QUEUE_NAMES.map((name) => [
      name,
      new Queue(name, { connection: fastify.redis, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    ])
  ) as Record<QueueName, Queue>;
  const vsl = vslQueuePlan(fastify.config);
  if (vsl.create) {
    for (const name of VSL_LEGACY_QUEUES) {
      const queue = new Queue(name, { connection: vsl.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      queue.on('error', (err: Error) => fastify.log.warn({ errName: err.name, queue: name }, 'VSL queue error'));
      queues[name] = queue;
    }
  } else if (vsl.reason === 'redis_missing') {
    fastify.log.warn('VSL_LEGACY_ENABLED=true sem VSL_REDIS_URL: filas VSL legacy não criadas');
  }

  const producer: QueueProducer = {
    queues,
    enqueue: async (queueName, jobName, data, opts) => {
      const queue = queues[queueName];
      if (!queue) {
        throw new Error(`Unknown queue: ${queueName}`);
      }
      // jobName explícito — dispatchers (factory) fazem switch por job.name;
      // processadores simples ignoram, mas mantemos o nome canônico do job
      // para legibilidade nos logs e nos Bull Board.
      // Story 18.4 · correlation id da requisição em opts.telemetry.metadata (job.data intocado).
      // Filas protegidas (email-queue, inbound-classify-queue, tracker-capi-queue) e chamadas
      // fora de requisição recebem as MESMAS opts (mesma referência).
      const job = await queue.add(jobName, data, correlationJobOptions(queueName, opts));
      return job.id ?? '';
    },
    close: async () => {
      await Promise.all(Object.values(queues).map((q) => q.close()));
    },
  };

  fastify.decorate('queue', producer);
  fastify.addHook('onClose', async () => {
    await producer.close();
  });
};

export default fp(queuePlugin, { name: 'queue-plugin', dependencies: ['redis-plugin'] });

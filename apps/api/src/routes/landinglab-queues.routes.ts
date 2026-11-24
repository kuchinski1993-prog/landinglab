// Fila do LandingLab via API — o backoffice (Vercel) não fala mais direto com o Redis.
//
// Por quê: o Redis vive na rede interna do Railway, sem acesso público. A Vercel não alcança
// essa rede; a API alcança (fastify.redis). Então o backoffice enfileira e consulta jobs por
// aqui, autenticado com o cookie de sessão do usuário, e o Redis fica fechado para a internet.
//
// Só filas e opções da lista abaixo: a rota não é um proxy genérico para o Redis.
import { Queue, type JobsOptions } from 'bullmq';
import type { FastifyPluginAsync } from 'fastify';

import '../types.js';

export const LANDINGLAB_QUEUES = [
  'landinglab.squad0.clone',
  'landinglab.squad1.research',
  'landinglab.squad5.deploy',
  'landinglab.translate-text',
  'landinglab.translate-images',
  'landinglab.export',
  'landinglab.apply-bundle',
  'kill-switch-reviews-phase2',
  'kill-switch-logos-phase2',
] as const;
type LandinglabQueue = (typeof LANDINGLAB_QUEUES)[number];

const ALLOWED_OPTS = ['jobId', 'attempts', 'backoff', 'removeOnComplete', 'removeOnFail', 'delay', 'priority'] as const;

// O clone pode levar o HTML colado (htmlOverride) — maior que o 1 MiB padrão do Fastify.
// A Vercel já corta o body em ~4,5 MB antes de chegar aqui.
const ENQUEUE_BODY_LIMIT = 10 * 1024 * 1024;

// Chamadas vêm do servidor da Vercel (poucos IPs, todos os usuários juntos) e o stream do clone
// consulta o job a cada 2 s — o limite global (100/min por IP) estouraria. Rotas exigem sessão.
const QUEUE_RATE_LIMIT = { max: 1_200, timeWindow: '1 minute' } as const;

/** Prazo de cada operação no Redis: a rota sempre responde, mesmo com o Redis fora. */
export const REDIS_OP_TIMEOUT_MS = 8_000;

interface QueueParams {
  queue: string;
}
interface JobParams extends QueueParams {
  jobId: string;
}
interface EnqueueBody {
  name: string;
  data: Record<string, unknown>;
  opts?: Record<string, unknown>;
  /** Se já houver job aguardando/ativo/atrasado com o mesmo data[dedupeBy], devolve esse job. */
  dedupeBy?: string;
}

const enqueueSchema = {
  body: {
    type: 'object',
    required: ['name', 'data'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      data: { type: 'object' },
      opts: { type: 'object' },
      dedupeBy: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
} as const;

/** Teto do lote: o kill-switch enfileira 1 job por landing afetada. */
export const MAX_BULK_JOBS = 2_000;

interface BulkBody {
  jobs: Array<{ name: string; data: Record<string, unknown>; opts?: Record<string, unknown> }>;
}

const bulkSchema = {
  body: {
    type: 'object',
    required: ['jobs'],
    additionalProperties: false,
    properties: {
      jobs: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_BULK_JOBS,
        items: {
          type: 'object',
          required: ['name', 'data'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            data: { type: 'object' },
            opts: { type: 'object' },
          },
        },
      },
    },
  },
} as const;

function isLandinglabQueue(name: string): name is LandinglabQueue {
  return (LANDINGLAB_QUEUES as readonly string[]).includes(name);
}

function pickOpts(raw: Record<string, unknown> | undefined): JobsOptions {
  const opts: Record<string, unknown> = {};
  if (!raw) return opts;
  for (const key of ALLOWED_OPTS) if (raw[key] !== undefined) opts[key] = raw[key];
  return opts as JobsOptions;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Redis não respondeu (${label})`)), REDIS_OP_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

const landinglabQueuesRoutes: FastifyPluginAsync = async (fastify) => {
  const queues = new Map<LandinglabQueue, Queue>();
  const getQueue = (name: LandinglabQueue): Queue => {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: fastify.redis });
      queue.on('error', (err: Error) => fastify.log.warn({ errName: err.name, queue: name }, 'landinglab queue error'));
      queues.set(name, queue);
    }
    return queue;
  };
  fastify.addHook('onClose', async () => {
    await Promise.all([...queues.values()].map((q) => q.close().catch(() => undefined)));
  });

  fastify.post<{ Params: QueueParams; Body: EnqueueBody }>(
    '/landinglab/queues/:queue/jobs',
    { preHandler: fastify.authenticate, schema: enqueueSchema, bodyLimit: ENQUEUE_BODY_LIMIT, config: { rateLimit: QUEUE_RATE_LIMIT } },
    async (request, reply) => {
      const { queue: queueName } = request.params;
      if (!isLandinglabQueue(queueName)) {
        return reply.code(404).send({ error: 'queue_not_found', message: `Fila desconhecida: ${queueName}` });
      }
      const { name, data, opts, dedupeBy } = request.body;
      const queue = getQueue(queueName);
      try {
        if (dedupeBy) {
          const value = data[dedupeBy];
          const pending = await withTimeout(queue.getJobs(['waiting', 'active', 'delayed'], 0, 50), queueName);
          const existing = pending.find((job) => job?.data?.[dedupeBy] === value);
          if (existing?.id) return reply.send({ jobId: existing.id, deduped: true });
        }
        const job = await withTimeout(queue.add(name, data, pickOpts(opts)), queueName);
        return reply.send({ jobId: job.id ?? '', deduped: false });
      } catch (err) {
        request.log.error({ errName: (err as Error).name, errMessage: (err as Error).message, queue: queueName }, 'landinglab enqueue falhou');
        return reply.code(503).send({ error: 'queue_unavailable', message: `Fila indisponível agora: ${(err as Error).message}` });
      }
    }
  );

  fastify.post<{ Params: QueueParams; Body: BulkBody }>(
    '/landinglab/queues/:queue/jobs/bulk',
    { preHandler: fastify.authenticate, schema: bulkSchema, config: { rateLimit: QUEUE_RATE_LIMIT } },
    async (request, reply) => {
      const { queue: queueName } = request.params;
      if (!isLandinglabQueue(queueName)) {
        return reply.code(404).send({ error: 'queue_not_found', message: `Fila desconhecida: ${queueName}` });
      }
      const jobs = request.body.jobs.map(({ name, data, opts }) => ({ name, data, opts: pickOpts(opts) }));
      try {
        const added = await withTimeout(getQueue(queueName).addBulk(jobs), queueName);
        return reply.send({ count: added.length });
      } catch (err) {
        request.log.error({ errName: (err as Error).name, errMessage: (err as Error).message, queue: queueName }, 'landinglab enqueue em lote falhou');
        return reply.code(503).send({ error: 'queue_unavailable', message: `Fila indisponível agora: ${(err as Error).message}` });
      }
    }
  );

  fastify.get<{ Params: JobParams }>(
    '/landinglab/queues/:queue/jobs/:jobId',
    { preHandler: fastify.authenticate, config: { rateLimit: QUEUE_RATE_LIMIT } },
    async (request, reply) => {
      const { queue: queueName, jobId } = request.params;
      if (!isLandinglabQueue(queueName)) {
        return reply.code(404).send({ error: 'queue_not_found', message: `Fila desconhecida: ${queueName}` });
      }
      try {
        const job = await withTimeout(getQueue(queueName).getJob(jobId), queueName);
        if (!job) return reply.code(404).send({ error: 'job_not_found', message: 'Job não encontrado' });
        const state = await withTimeout(job.getState(), queueName);
        return reply.send({
          jobId: job.id,
          state,
          progress: job.progress ?? null,
          returnvalue: job.returnvalue ?? null,
          failedReason: job.failedReason ?? null,
          data: job.data ?? null,
        });
      } catch (err) {
        request.log.error({ errName: (err as Error).name, errMessage: (err as Error).message, queue: queueName }, 'landinglab job lookup falhou');
        return reply.code(503).send({ error: 'queue_unavailable', message: `Fila indisponível agora: ${(err as Error).message}` });
      }
    }
  );
};

export default landinglabQueuesRoutes;

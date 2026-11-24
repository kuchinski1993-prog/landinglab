// Story 18.3 · Teste COMPLEMENTAR com Worker BullMQ real — só roda com REDIS_URL (o repositório
// não tem Redis de teste nem ioredis-mock). Os ACs são provados pelos testes com job simulado +
// PGlite; este confirma a integração com o motor (retry com backoff, UnrecoverableError).
// Rodar: REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @blackshop/jobs test
import { randomUUID } from 'node:crypto';

import { Queue, QueueEvents, Worker } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';

import { DeterministicJobError } from '../index.js';
import { createMemoryJobRunStore } from '../store.js';
import { durableProcessor, type DurableJob } from '../worker.js';

const REDIS_URL = process.env['REDIS_URL'];

function connection(): { host: string; port: number; password?: string; maxRetriesPerRequest: null } {
  const url = new URL(REDIS_URL!);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    maxRetriesPerRequest: null,
  };
}

describe.skipIf(!REDIS_URL)('durableProcessor com BullMQ real (opcional)', () => {
  const closers: Array<() => Promise<unknown>> = [];
  afterAll(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined);
  });

  async function setup(handler: (job: DurableJob) => Promise<unknown>) {
    const name = `jobs-test-${randomUUID()}`;
    const store = createMemoryJobRunStore();
    const queue = new Queue(name, { connection: connection() });
    const events = new QueueEvents(name, { connection: connection() });
    const worker = new Worker(name, durableProcessor(handler, { queue: name, store }), { connection: connection() });
    closers.push(() => worker.close(), () => events.close(), () => queue.obliterate({ force: true }), () => queue.close());
    await events.waitUntilReady();
    return { name, store, queue, events };
  }

  it('transitório 2× e sucesso na 3ª: succeeded com attempts=3', async () => {
    let calls = 0;
    const { name, store, queue, events } = await setup(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return { ok: true };
    });
    const job = await queue.add('t', {}, { attempts: 3, backoff: { type: 'fixed', delay: 20 } });
    await job.waitUntilFinished(events, 15_000);
    expect(calls).toBe(3);
    expect(await store.get({ queue: name, jobKey: String(job.id) })).toMatchObject({ state: 'succeeded', attempts: 3 });
  });

  it('determinístico: 1 execução, failed, sem retry do BullMQ', async () => {
    let calls = 0;
    const { name, store, queue, events } = await setup(async () => {
      calls += 1;
      throw new DeterministicJobError('loja.relink_product_not_found', 'sem produto');
    });
    const job = await queue.add('t', {}, { attempts: 3, backoff: { type: 'fixed', delay: 20 } });
    await expect(job.waitUntilFinished(events, 15_000)).rejects.toThrow(/sem produto/);
    expect(calls).toBe(1);
    expect(await store.get({ queue: name, jobKey: String(job.id) })).toMatchObject({ state: 'failed', errorKind: 'deterministic' });
  });
});

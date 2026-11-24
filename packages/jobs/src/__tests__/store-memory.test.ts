// Story 18.3 · Store em memória com a mesma semântica do Drizzle (reserve/fencing/GC) +
// caminhos do producer que não dependem do banco (ledger fora, jobId).
import { describe, expect, it } from 'vitest';

import { gcJobRuns } from '../gc.js';
import { defaultJobId, enqueueDurable, reconcileQueuedFailed } from '../producer.js';
import { createMemoryJobRunStore, type JobRunStore } from '../store.js';

import { silentLogger } from './helpers.js';

const key = { queue: 'q', jobKey: 'k' };

describe('store em memória', () => {
  it('reserve: cria, deduplica linha viva e reabre desfecho', async () => {
    const store = createMemoryJobRunStore();
    expect((await store.reserve({ ...key, maxAttempts: 3, jobName: 'J', storeId: 's1', correlationId: 'c1' })).reserved).toBe(true);
    expect((await store.reserve({ ...key, maxAttempts: 3 })).reserved).toBe(false);
    const lease = await store.begin({ ...key, leaseMs: 1_000, maxAttempts: 3 });
    expect(await store.fail(lease, { state: 'failed', errorKind: 'deterministic', errorCode: 'x', lastError: 'y' })).toBe(true);
    const reopened = await store.reserve({ ...key, maxAttempts: 5 });
    expect(reopened).toMatchObject({ reserved: true, run: { state: 'queued', attempts: 0, maxAttempts: 5, errorCode: null, jobName: 'J', storeId: 's1' } });
  });

  it('markQueuedFailed só a partir de queued', async () => {
    const store = createMemoryJobRunStore();
    expect(await store.markQueuedFailed(key, { errorCode: 'e', lastError: null })).toBe(false);
    await store.reserve({ ...key, maxAttempts: 1 });
    expect(await store.markQueuedFailed(key, { errorCode: 'e', lastError: null })).toBe(true);
    expect(await store.markQueuedFailed(key, { errorCode: 'e', lastError: null })).toBe(false);
  });

  it('fencing: token antigo não grava; heartbeat só em running', async () => {
    const store = createMemoryJobRunStore();
    const a = await store.begin({ ...key, leaseMs: 1_000, maxAttempts: 3 });
    const b = await store.begin({ ...key, leaseMs: 1_000, maxAttempts: 3 });
    expect(b.attempts).toBe(2);
    expect(await store.succeed(a)).toBe(false);
    expect(await store.fail(a, { state: 'failed', errorKind: 'transient', errorCode: null, lastError: null })).toBe(false);
    expect(await store.heartbeat(a, 1_000)).toBe(false);
    expect(await store.heartbeat(b, 5_000)).toBe(true);
    expect(await store.succeed(b, { ok: 1 })).toBe(true);
    expect(await store.heartbeat(b, 1_000)).toBe(false);
    expect(await store.succeed({ ...b, jobKey: 'outro' })).toBe(false);
    expect(await store.get({ queue: 'q', jobKey: 'nada' })).toBeNull();
  });

  it('GC dry-run × apply com relógio controlado', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = createMemoryJobRunStore({ now: () => now });
    const make = async (jobKey: string, outcome: 'succeed' | 'fail' | 'run') => {
      const lease = await store.begin({ queue: 'q', jobKey, leaseMs: 1_000, maxAttempts: 1 });
      if (outcome === 'succeed') await store.succeed(lease);
      if (outcome === 'fail') await store.fail(lease, { state: 'failed', errorKind: 'deterministic', errorCode: 'x', lastError: null });
    };
    await make('ok', 'succeed');
    await make('ko', 'fail');
    await make('zumbi', 'run');
    await store.reserve({ queue: 'q', jobKey: 'fila', maxAttempts: 1 });
    now = new Date('2026-03-01T00:00:00Z'); // +59 dias
    const dry = await gcJobRuns(store, { now });
    expect(dry.plan).toEqual([
      { queue: 'q', state: 'running', action: 'mark_lost', count: 1 },
      { queue: 'q', state: 'succeeded', action: 'delete', count: 1 },
    ]);
    expect(store.rows()).toHaveLength(4);
    const applied = await gcJobRuns(store, { now, dryRun: false });
    expect(applied).toMatchObject({ deleted: 1, markedLost: 1 });
    expect(store.rows().map((r) => `${r.jobKey}:${r.state}`).sort()).toEqual(['fila:queued', 'ko:failed', 'zumbi:lost']);
    expect((await store.list({ states: ['lost'], queue: 'q', limit: 1 })).map((r) => r.jobKey)).toEqual(['zumbi']);
  });
});

describe('órfãos no store em memória (QA REL-001)', () => {
  it('running com lease vencido > staleRunningMs e queued/retrying parado > staleQueuedMs são reabertos', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = createMemoryJobRunStore({ now: () => now });
    await store.begin({ ...key, leaseMs: 30_000, maxAttempts: 3 });
    now = new Date(now.getTime() + 60_000); // lease venceu há 30 s
    expect((await store.reserve({ ...key, maxAttempts: 3 })).reserved).toBe(false);
    now = new Date(now.getTime() + 60_000); // venceu há 90 s
    expect((await store.reserve({ ...key, maxAttempts: 3, replay: { a: 1 } })).run.replay).toEqual({ a: 1 });
    // agora queued: 30 min depois ainda vivo; 2 h depois órfão.
    now = new Date(now.getTime() + 30 * 60_000);
    expect((await store.reserve({ ...key, maxAttempts: 3 })).reserved).toBe(false);
    now = new Date(now.getTime() + 2 * 60 * 60_000);
    expect((await store.reserve({ ...key, maxAttempts: 3, staleQueuedMs: 60_000 })).reserved).toBe(true);
  });
});

describe('producer', () => {
  it('ledger fora no reserve: loga e enfileira assim mesmo (ledger=false)', async () => {
    const store = createMemoryJobRunStore();
    (store as JobRunStore).reserve = async () => {
      throw new Error('db fora');
    };
    const logger = silentLogger();
    const jobs: string[] = [];
    const result = await enqueueDurable(
      store,
      async (_n, _d, opts) => void jobs.push(opts.jobId),
      { queue: 'q', jobKey: 'a:b', jobName: 'J', data: {} },
      { logger, jobIdOf: () => 'fixo' },
    );
    expect(result).toEqual({ enqueued: true, jobId: 'fixo', ledger: false, run: null });
    expect(jobs).toEqual(['fixo']);
    expect(logger.entries[0]).toMatchObject({ msg: 'job_ledger_write_failed', obj: { op: 'reserve' } });

    // ledger fora e add falhando: JobEnqueueError sem tentar marcar.
    await expect(
      enqueueDurable(store, async () => Promise.reject(new Error('redis')), { queue: 'q', jobKey: 'a', jobName: 'J', data: {} }, { logger }),
    ).rejects.toMatchObject({ code: 'plataforma.job_enqueue_failed' });
  });

  it('markQueuedFailed falhando: loga e ainda lança JobEnqueueError', async () => {
    const store = createMemoryJobRunStore();
    store.markQueuedFailed = async () => {
      throw new Error('db caiu no meio');
    };
    const logger = silentLogger();
    await expect(
      enqueueDurable(store, async () => Promise.reject(new Error('redis')), { queue: 'q', jobKey: 'a', jobName: 'J', data: {}, storeId: 's', correlationId: 'c' }, { logger }),
    ).rejects.toMatchObject({ name: 'JobEnqueueError' });
    expect(logger.entries[0]?.obj['op']).toBe('markQueuedFailed');
  });

  it('defaultJobId: formato a:b:c aceito pelo BullMQ', () => {
    expect(defaultJobId('relink:p1', 123)).toBe('relink:p1:123');
    expect(defaultJobId('simples', 5)).toBe('simples:run:5');
    expect(defaultJobId('a:b:c', 5)).toBe('a_b_c:run:5');
    expect(defaultJobId('x').split(':')).toHaveLength(3);
  });

  it('reconcile em memória usa logger/jobIdOf e não reenfileira linha viva', async () => {
    const store = createMemoryJobRunStore();
    await enqueueDurable(store, async () => Promise.reject(new Error('redis')), { queue: 'q', jobKey: 'r', jobName: 'J', data: {} }).catch(() => undefined);
    const report = await reconcileQueuedFailed(store, () => async () => undefined, () => ({}), {
      dryRun: false,
      logger: silentLogger(),
      jobIdOf: () => 'id-fixo',
      limit: 10,
    });
    expect(report.requeued).toBe(1);
    expect((await store.get({ queue: 'q', jobKey: 'r' }))?.state).toBe('queued');
  });
});

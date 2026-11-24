// Story 18.3 · Ledger job_runs contra Postgres real (PGlite) — SQL Drizzle de produção, sem mocks.
// AC1 (migration + CHECKs + RLS + rollback/reaplicação), AC5 (worker morre no meio: fencing),
// AC6 (enqueue durável idempotente, queued_failed → reconcile), AC14 (GC dry-run × apply).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { gcJobRuns } from '../gc.js';
import { enqueueDurable, reconcileQueuedFailed } from '../producer.js';
import { createDrizzleJobRunStore, type JobRunStore } from '../store.js';
import { startJobRunsTestDatabase, JOB_RUNS_MIGRATION, JOB_RUNS_ROLLBACK, type JobRunsTestDatabase } from '../testing/pg-harness.js';
import { durableProcessor } from '../worker.js';

import { runLikeBullMQ } from './helpers.js';

const QUEUE = 'relink-colors-queue';

let pg: JobRunsTestDatabase;
let storeA: JobRunStore;
let storeB: JobRunStore;

beforeAll(async () => {
  pg = await startJobRunsTestDatabase();
  storeA = createDrizzleJobRunStore(pg.drizzle());
  storeB = createDrizzleJobRunStore(pg.drizzle());
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.reset();
});

async function schemaSnapshot(): Promise<string> {
  const cols = await pg.sql`
    SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_name = 'job_runs' ORDER BY column_name`;
  const cons = await pg.sql`
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'job_runs'::regclass ORDER BY conname`;
  const idx = await pg.sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'job_runs' ORDER BY indexname`;
  const rls = await pg.sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'job_runs'`;
  return JSON.stringify({ cols, cons, idx, rls });
}

describe('migration 0097 (AC1)', () => {
  it('tabela com CHECKs, UNIQUE, índices, RLS habilitado e sem policies', async () => {
    const [rls] = await pg.sql<{ relrowsecurity: boolean }[]>`SELECT relrowsecurity FROM pg_class WHERE relname = 'job_runs'`;
    expect(rls?.relrowsecurity).toBe(true);
    const policies = await pg.sql`SELECT 1 FROM pg_policies WHERE tablename = 'job_runs'`;
    expect(policies).toHaveLength(0);
    const idx = (await pg.sql<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'job_runs'`).map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(['uq_job_runs_queue_job_key', 'idx_job_runs_state_lease', 'idx_job_runs_queue_state']));
    await expect(pg.sql`INSERT INTO job_runs (queue, job_key, state) VALUES ('q', 'k', 'rodando')`).rejects.toThrow(/job_runs_state_check/);
    await expect(pg.sql`INSERT INTO job_runs (queue, job_key, error_kind) VALUES ('q', 'k', 'fatal')`).rejects.toThrow(/job_runs_error_kind_check/);
    await expect(pg.sql`INSERT INTO job_runs (queue, job_key, last_error) VALUES ('q', 'k', ${'x'.repeat(501)})`).rejects.toThrow(
      /job_runs_last_error_len_check/,
    );
    await pg.sql`INSERT INTO job_runs (queue, job_key) VALUES ('q', 'k')`;
    await expect(pg.sql`INSERT INTO job_runs (queue, job_key) VALUES ('q', 'k')`).rejects.toThrow(/uq_job_runs_queue_job_key/);
  });

  it('rollback + reaplicação deixa o banco igual', async () => {
    const before = await schemaSnapshot();
    await pg.sql.unsafe(await pg.migration(JOB_RUNS_ROLLBACK));
    const [gone] = await pg.sql<{ t: string | null }[]>`SELECT to_regclass('public.job_runs')::text AS t`;
    expect(gone?.t).toBeNull();
    await pg.sql.unsafe(await pg.migration(JOB_RUNS_MIGRATION));
    expect(await schemaSnapshot()).toBe(before);
  });
});

describe('fencing — worker morre no meio (AC5)', () => {
  const key = { queue: QUEUE, jobKey: 'relink:p1' };

  it('B assume com attempts+1; A acorda com o token antigo e nada é gravado', async () => {
    const leaseA = await storeA.begin({ ...key, leaseMs: 1, maxAttempts: 3 });
    expect(leaseA.attempts).toBe(1);
    // A "morre": o lease vence.
    await new Promise((r) => setTimeout(r, 10));
    const leaseB = await storeB.begin({ ...key, leaseMs: 30_000, maxAttempts: 3 });
    expect(leaseB.attempts).toBe(2);
    expect(leaseB.token).not.toBe(leaseA.token);
    expect(await storeB.succeed(leaseB, { status: 'linked' })).toBe(true);

    // A acorda: succeed/fail/heartbeat com o token antigo afetam 0 linhas.
    expect(await storeA.succeed(leaseA, { status: 'zumbi' })).toBe(false);
    expect(await storeA.fail(leaseA, { state: 'failed', errorKind: 'deterministic', errorCode: 'x', lastError: 'zumbi' })).toBe(false);
    expect(await storeA.heartbeat(leaseA, 30_000)).toBe(false);

    const [row] = await pg.sql`SELECT state, attempts, result, error_code, lease_token FROM job_runs WHERE job_key = 'relink:p1'`;
    expect(row).toMatchObject({ state: 'succeeded', attempts: 2, result: { status: 'linked' }, error_code: null, lease_token: null });
  });

  it('A em execução (lease válido) também é desbancado por B; heartbeat de B estende o lease', async () => {
    const leaseA = await storeA.begin({ ...key, leaseMs: 60_000, maxAttempts: 3 });
    const leaseB = await storeB.begin({ ...key, leaseMs: 1_000, maxAttempts: 3 });
    const [before] = await pg.sql<{ lease_until: Date }[]>`SELECT lease_until FROM job_runs WHERE job_key = 'relink:p1'`;
    expect(await storeB.heartbeat(leaseB, 120_000)).toBe(true);
    const [after] = await pg.sql<{ lease_until: Date }[]>`SELECT lease_until FROM job_runs WHERE job_key = 'relink:p1'`;
    expect(after!.lease_until.getTime()).toBeGreaterThan(before!.lease_until.getTime());
    expect(await storeA.fail(leaseA, { state: 'retrying', errorKind: 'transient', errorCode: 'x', lastError: null })).toBe(false);
    expect(await storeB.fail(leaseB, { state: 'retrying', errorKind: 'transient', errorCode: 'ECONNRESET', lastError: 'reset' })).toBe(true);
    expect(await storeA.get(key)).toMatchObject({ state: 'retrying', attempts: 2, errorCode: 'ECONNRESET', finishedAt: null });
  });

  it('nova execução depois de um desfecho recomeça attempts em 1; depois de lost soma', async () => {
    const l1 = await storeA.begin({ ...key, leaseMs: 1_000, maxAttempts: 3 });
    await storeA.succeed(l1);
    expect((await storeA.begin({ ...key, leaseMs: 1_000, maxAttempts: 3 })).attempts).toBe(1);
    await pg.sql`UPDATE job_runs SET state = 'lost' WHERE job_key = 'relink:p1'`;
    expect((await storeA.begin({ ...key, leaseMs: 1_000, maxAttempts: 3 })).attempts).toBe(2);
  });

  it('wrapper com store Drizzle: transitório 2× e sucesso → retrying, retrying, succeeded', async () => {
    let calls = 0;
    const processor = durableProcessor(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        return { ok: true };
      },
      { queue: QUEUE, store: storeA, keyOf: () => 'wrap-1' },
    );
    const run = await runLikeBullMQ(processor, {}, { attempts: 3 });
    expect(run.outcome).toBe('completed');
    expect(await storeA.get({ queue: QUEUE, jobKey: 'wrap-1' })).toMatchObject({ state: 'succeeded', attempts: 3, result: { ok: true } });
  });
});

describe('enqueue durável (AC6)', () => {
  const input = { queue: QUEUE, jobKey: 'relink:p9', jobName: 'RelinkColorsJob', data: { productId: 'p9' } };

  it('add lançando → queued_failed + JobEnqueueError (503); nunca running; reconcile leva a queued e executa', async () => {
    const err = await enqueueDurable(storeA, async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    }, input).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'JobEnqueueError', code: 'plataforma.job_enqueue_failed', statusCode: 503 });
    expect(await storeA.get(input)).toMatchObject({ state: 'queued_failed', errorCode: 'plataforma.job_enqueue_failed', errorKind: 'transient' });

    // dry-run lista e não altera.
    const added: Array<{ name: string; data: unknown; jobId: string }> = [];
    const enqueueFor = () => async (name: string, data: unknown, opts: { jobId: string }) => void added.push({ name, data, jobId: opts.jobId });
    const dry = await reconcileQueuedFailed(storeA, enqueueFor, () => ({ productId: 'p9' }));
    expect(dry).toMatchObject({ dryRun: true, requeued: 0, candidates: [{ jobKey: 'relink:p9', errorCode: 'plataforma.job_enqueue_failed' }] });
    expect(added).toHaveLength(0);
    expect((await storeA.get(input))?.state).toBe('queued_failed');

    // apply re-enfileira → queued, e o job executa pelo wrapper.
    const applied = await reconcileQueuedFailed(storeA, enqueueFor, (run) => ({ productId: run.jobKey.split(':')[1] }), { dryRun: false });
    expect(applied).toMatchObject({ requeued: 1, failed: 0 });
    expect(added).toEqual([{ name: 'RelinkColorsJob', data: { productId: 'p9' }, jobId: expect.stringMatching(/^relink:p9:\d+$/) }]);
    expect(await storeA.get(input)).toMatchObject({ state: 'queued', errorCode: null, attempts: 0 });
    const processor = durableProcessor(async () => 'ok', { queue: QUEUE, store: storeA, keyOf: () => 'relink:p9' });
    await runLikeBullMQ(processor, {});
    expect((await storeA.get(input))?.state).toBe('succeeded');
  });

  it('duas chamadas com o mesmo jobKey: 1 job e 1 linha; depois do desfecho, reenfileira', async () => {
    const calls: string[] = [];
    const enqueue = async (_n: string, _d: unknown, opts: { jobId: string }) => void calls.push(opts.jobId);
    const [r1, r2] = await Promise.all([enqueueDurable(storeA, enqueue, input), enqueueDurable(storeB, enqueue, input)]);
    expect([r1.enqueued, r2.enqueued].sort()).toEqual([false, true]);
    expect(calls).toHaveLength(1);
    expect(await enqueueDurable(storeA, enqueue, input)).toMatchObject({ enqueued: false, jobId: null });
    const [{ n }] = await pg.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM job_runs`;
    expect(n).toBe(1);

    const lease = await storeA.begin({ ...input, leaseMs: 1_000, maxAttempts: 3 });
    await storeA.succeed(lease);
    expect((await enqueueDurable(storeA, enqueue, input)).enqueued).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('reconcile com dataOf null pula a linha; enqueue que falha de novo conta como failed', async () => {
    await enqueueDurable(storeA, async () => Promise.reject(new Error('down')), input).catch(() => undefined);
    const skip = await reconcileQueuedFailed(storeA, () => async () => undefined, () => null, { dryRun: false });
    expect(skip).toMatchObject({ requeued: 0, failed: 0 });
    const again = await reconcileQueuedFailed(storeA, () => async () => Promise.reject(new Error('down')), () => ({}), {
      dryRun: false,
      queue: QUEUE,
    });
    expect(again).toMatchObject({ requeued: 0, failed: 1 });
    expect((await storeA.get(input))?.state).toBe('queued_failed');
  });
});

describe('GC (AC14)', () => {
  async function seed(): Promise<void> {
    await pg.sql`
      INSERT INTO job_runs (queue, job_key, state, finished_at, lease_until) VALUES
        ('q1', 'old-ok',      'succeeded', now() - interval '31 days', NULL),
        ('q1', 'recent-ok',   'succeeded', now() - interval '1 day',   NULL),
        ('q1', 'old-fail',    'failed',    now() - interval '91 days', NULL),
        ('q2', 'mid-fail',    'failed',    now() - interval '40 days', NULL),
        ('q2', 'old-unc',     'uncertain', now() - interval '100 days', NULL),
        ('q2', 'zombie',      'running',   NULL, now() - interval '10 minutes'),
        ('q2', 'alive',       'running',   NULL, now() + interval '1 minute'),
        ('q2', 'qf',          'queued_failed', NULL, NULL),
        ('q2', 'retry',       'retrying',  NULL, NULL)`;
  }

  async function snapshot(): Promise<unknown> {
    return pg.sql`SELECT job_key, state FROM job_runs ORDER BY job_key`;
  }

  it('dry-run (padrão) não altera nada e devolve o plano por fila/estado', async () => {
    await seed();
    const before = await snapshot();
    const report = await gcJobRuns(storeA);
    expect(report.dryRun).toBe(true);
    expect(report).toMatchObject({ deleted: 0, markedLost: 0 });
    expect(report.plan).toEqual([
      { queue: 'q1', state: 'failed', action: 'delete', count: 1 },
      { queue: 'q1', state: 'succeeded', action: 'delete', count: 1 },
      { queue: 'q2', state: 'running', action: 'mark_lost', count: 1 },
      { queue: 'q2', state: 'uncertain', action: 'delete', count: 1 },
    ]);
    expect(await snapshot()).toEqual(before);
  });

  it('apply remove desfechos antigos, marca lost os running sem lease e preserva o recente', async () => {
    await seed();
    const report = await gcJobRuns(storeA, { dryRun: false });
    expect(report).toMatchObject({ dryRun: false, deleted: 3, markedLost: 1 });
    const rows = (await snapshot()) as Array<{ job_key: string; state: string }>;
    expect(rows).toEqual([
      { job_key: 'alive', state: 'running' },
      { job_key: 'mid-fail', state: 'failed' },
      { job_key: 'qf', state: 'queued_failed' },
      { job_key: 'recent-ok', state: 'succeeded' },
      { job_key: 'retry', state: 'retrying' },
      { job_key: 'zombie', state: 'lost' },
    ]);
  });

  it('retenção ajustável e validada', async () => {
    await seed();
    const report = await gcJobRuns(storeA, { failedOlderThanDays: 30 });
    expect(report.plan.find((p) => p.queue === 'q2' && p.state === 'failed')?.count).toBe(1);
    await expect(gcJobRuns(storeA, { succeededOlderThanDays: 0 })).rejects.toThrow(/>= 1/);
  });
});

describe('list', () => {
  it('filtra por estado e fila', async () => {
    await pg.sql`INSERT INTO job_runs (queue, job_key, state) VALUES ('a', '1', 'queued'), ('b', '2', 'queued'), ('a', '3', 'failed')`;
    expect((await storeA.list({ states: ['queued'] })).map((r) => r.jobKey)).toEqual(['1', '2']);
    expect((await storeA.list({ queue: 'a' })).map((r) => r.jobKey).sort()).toEqual(['1', '3']);
    expect(await storeA.list()).toHaveLength(3);
  });
});

describe('órfãos (QA REL-001)', () => {
  const key = { queue: QUEUE, jobKey: 'relink:orfao' };
  const reserve = (extra: Record<string, unknown> = {}) => storeA.reserve({ ...key, maxAttempts: 3, ...extra });

  it('running com lease vencido há mais de 2× lease é reaberto; com lease válido não', async () => {
    await storeA.begin({ ...key, leaseMs: 30_000, maxAttempts: 3 });
    expect((await reserve()).reserved).toBe(false);
    // Vencido há só 10 s (< 60 s padrão): ainda vivo.
    await pg.sql`UPDATE job_runs SET lease_until = now() - interval '10 seconds' WHERE job_key = 'relink:orfao'`;
    expect((await reserve()).reserved).toBe(false);
    await pg.sql`UPDATE job_runs SET lease_until = now() - interval '2 minutes' WHERE job_key = 'relink:orfao'`;
    const reopened = await reserve();
    expect(reopened).toMatchObject({ reserved: true, run: { state: 'queued', attempts: 0, leaseToken: null } });
  });

  it('staleRunningMs ajustável', async () => {
    await storeA.begin({ ...key, leaseMs: 1_000, maxAttempts: 3 });
    await pg.sql`UPDATE job_runs SET lease_until = now() - interval '10 seconds' WHERE job_key = 'relink:orfao'`;
    expect((await reserve({ staleRunningMs: 5_000 })).reserved).toBe(true);
  });

  it.each(['queued', 'retrying'])('%s parado há mais de 1 h é reaberto; recente não', async (state) => {
    await pg.sql`INSERT INTO job_runs (queue, job_key, state, updated_at) VALUES (${QUEUE}, 'relink:orfao', ${state}, now() - interval '10 minutes')`;
    expect((await reserve()).reserved).toBe(false);
    await pg.sql`UPDATE job_runs SET updated_at = now() - interval '2 hours' WHERE job_key = 'relink:orfao'`;
    expect((await reserve()).reserved).toBe(true);
  });

  it('worker antigo do órfão reaberto não grava (fencing)', async () => {
    const old = await storeA.begin({ ...key, leaseMs: 1_000, maxAttempts: 3 });
    await pg.sql`UPDATE job_runs SET lease_until = now() - interval '5 minutes' WHERE job_key = 'relink:orfao'`;
    await reserve();
    expect(await storeA.succeed(old)).toBe(false);
    expect(await storeA.heartbeat(old, 1_000)).toBe(false);
    expect((await storeA.get(key))?.state).toBe('queued');
  });

  it('replay é guardado no reserve e devolvido ao reconcile', async () => {
    await reserve({ replay: { republishToShopify: false } });
    expect((await storeA.get(key))?.replay).toEqual({ republishToShopify: false });
  });
});

describe('renovação automática do lease (QA REL-001)', () => {
  it('heartbeat a cada leaseMs/2 enquanto roda e para no fim', async () => {
    // O SQL do heartbeat roda de verdade (Drizzle → PGlite); o handler NÃO consulta o banco por
    // outra conexão durante as renovações — o socket do PGlite é uma sessão só e não intercala
    // comandos de conexões diferentes com segurança (QA TEST-001). A prova do avanço do lease é
    // o valor gravado por cada heartbeat aceito, lido depois que o job termina.
    const key = { queue: QUEUE, jobKey: 'hb-1' };
    const accepted: number[] = [];
    const store: JobRunStore = {
      ...storeA,
      heartbeat: async (lease, ms) => {
        const ok = await storeA.heartbeat(lease, ms);
        if (ok) accepted.push(Date.now());
        return ok;
      },
    };
    const leaseBefore: { at: Date | null } = { at: null };
    const processor = durableProcessor(
      async () => {
        await new Promise((r) => setTimeout(r, 1_100));
        return 'ok';
      },
      {
        queue: QUEUE,
        store: {
          ...store,
          begin: async (input) => {
            const lease = await storeA.begin(input);
            leaseBefore.at = (await storeA.get(key))?.leaseUntil ?? null;
            return lease;
          },
        },
        keyOf: () => 'hb-1',
        leaseMs: 400,
      },
    );
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runLikeBullMQ(processor, {});
    // ~5 renovações (a cada 200 ms) aceitas pelo banco; nenhuma falha de escrita.
    expect(accepted.length).toBeGreaterThanOrEqual(3);
    expect(stderr).not.toHaveBeenCalledWith('job_ledger_write_failed', expect.anything());
    stderr.mockRestore();
    const [{ updated }] = await pg.sql<{ updated: Date }[]>`SELECT updated_at AS updated FROM job_runs WHERE job_key = 'hb-1'`;
    expect(updated.getTime()).toBeGreaterThan(leaseBefore.at!.getTime() - 400);
    expect(await storeA.get(key)).toMatchObject({ state: 'succeeded', leaseToken: null });
  });

  it('a última renovação aceita estendeu o lease no banco (lido sem concorrência)', async () => {
    const key = { queue: QUEUE, jobKey: 'hb-2' };
    const lease = await storeA.begin({ ...key, leaseMs: 1_000, maxAttempts: 1 });
    const before = (await storeA.get(key))!.leaseUntil!.getTime();
    await new Promise((r) => setTimeout(r, 50));
    expect(await storeA.heartbeat(lease, 60_000)).toBe(true);
    expect((await storeA.get(key))!.leaseUntil!.getTime()).toBeGreaterThan(before + 50_000);
  });
});


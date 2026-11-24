// Story 18.3 · JobRunStore sobre Drizzle (@blackshop/db, tabela job_runs da 0097).
// Escritas curtas e indexadas (UNIQUE (queue, job_key)); fencing por lease_token em todo
// UPDATE de uma tentativa. Testado contra Postgres real (PGlite) — sem mocks do SQL.
import { randomUUID } from 'node:crypto';

import { jobRuns, type Database, type JobRunRow } from '@blackshop/db';
import { and, asc, eq, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';

import type {
  BeginInput,
  FailInput,
  GcCriteria,
  GcPlanRow,
  JobLease,
  JobRunStore,
  ListFilter,
  ReserveInput,
  ReserveResult,
} from './store-types.js';
import { STALE_QUEUED_MS, STALE_RUNNING_MS } from './store-types.js';
import type { JobErrorKind, JobRun, JobRunKey, JobRunState } from './types.js';

function toRun(row: JobRunRow): JobRun {
  return {
    ...row,
    state: row.state as JobRunState,
    errorKind: (row.errorKind as JobErrorKind | null) ?? null,
    result: row.result ?? null,
    replay: (row.replay as Record<string, unknown> | null) ?? null,
  };
}

const keyWhere = (key: JobRunKey): SQL =>
  and(eq(jobRuns.queue, key.queue), eq(jobRuns.jobKey, key.jobKey)) as SQL;

const leaseWhere = (lease: JobLease): SQL => and(keyWhere(lease), eq(jobRuns.leaseToken, lease.token)) as SQL;

const leaseUntil = (ms: number): SQL => sql`now() + (${Math.max(0, Math.round(ms))} * interval '1 millisecond')`;

/** Condição de GC por linha (mesma regra do store em memória). */
function gcDeleteWhere(criteria: GcCriteria): SQL {
  return or(
    and(eq(jobRuns.state, 'succeeded'), lt(jobRuns.finishedAt, criteria.succeededBefore)),
    and(inArray(jobRuns.state, ['failed', 'uncertain', 'lost']), lt(jobRuns.finishedAt, criteria.failedBefore)),
  ) as SQL;
}

function gcLostWhere(criteria: GcCriteria): SQL {
  return and(
    eq(jobRuns.state, 'running'),
    isNotNull(jobRuns.leaseUntil),
    lt(jobRuns.leaseUntil, criteria.leaseExpiredBefore),
  ) as SQL;
}

export function createDrizzleJobRunStore(db: Database): JobRunStore {
  const store: JobRunStore = {
    async reserve(input: ReserveInput): Promise<ReserveResult> {
      const staleRunning = Math.max(0, Math.round(input.staleRunningMs ?? STALE_RUNNING_MS));
      const staleQueued = Math.max(0, Math.round(input.staleQueuedMs ?? STALE_QUEUED_MS));
      const rows = await db
        .insert(jobRuns)
        .values({
          storeId: input.storeId ?? 'default',
          queue: input.queue,
          jobKey: input.jobKey,
          jobName: input.jobName ?? null,
          state: 'queued',
          attempts: 0,
          maxAttempts: input.maxAttempts,
          correlationId: input.correlationId ?? null,
          replay: input.replay ?? null,
        })
        .onConflictDoUpdate({
          target: [jobRuns.queue, jobRuns.jobKey],
          set: {
            state: 'queued',
            attempts: 0,
            maxAttempts: input.maxAttempts,
            jobName: sql`COALESCE(excluded.job_name, ${jobRuns.jobName})`,
            correlationId: sql`excluded.correlation_id`,
            replay: sql`excluded.replay`,
            leaseToken: null,
            leaseUntil: null,
            errorKind: null,
            errorCode: null,
            lastError: null,
            result: null,
            startedAt: null,
            finishedAt: null,
            updatedAt: sql`now()`,
          },
          // Linha viva (queued/running/retrying) não é reaberta: o mesmo jobKey não vira 2 jobs.
          // Exceção (QA REL-001): órfãos — running com lease vencido há mais de staleRunningMs
          // (o durableProcessor renova o lease a cada leaseMs/2 enquanto roda) e queued/retrying
          // parados há mais de staleQueuedMs (job sumiu do Redis ou a API morreu antes do add).
          setWhere: sql`(${jobRuns.state} IN ('queued_failed', 'succeeded', 'failed', 'uncertain', 'lost')
            OR (${jobRuns.state} = 'running' AND ${jobRuns.leaseUntil} < now() - (${staleRunning} * interval '1 millisecond'))
            OR (${jobRuns.state} IN ('queued', 'retrying') AND ${jobRuns.updatedAt} < now() - (${staleQueued} * interval '1 millisecond')))`,
        })
        .returning();
      if (rows[0]) return { reserved: true, run: toRun(rows[0]) };
      const current = await store.get(input);
      if (!current) throw new Error(`job_runs: linha ${input.queue}/${input.jobKey} sumiu durante o reserve`);
      return { reserved: false, run: current };
    },

    async markQueuedFailed(key, error) {
      const rows = await db
        .update(jobRuns)
        .set({
          state: 'queued_failed',
          errorKind: 'transient',
          errorCode: error.errorCode,
          lastError: error.lastError,
          updatedAt: sql`now()`,
        })
        .where(and(keyWhere(key), eq(jobRuns.state, 'queued')))
        .returning({ id: jobRuns.id });
      return rows.length > 0;
    },

    async begin(input: BeginInput): Promise<JobLease> {
      const token = randomUUID();
      const fresh = sql`${jobRuns.state} IN ('succeeded', 'failed', 'uncertain')`;
      const rows = await db
        .insert(jobRuns)
        .values({
          storeId: input.storeId ?? 'default',
          queue: input.queue,
          jobKey: input.jobKey,
          jobName: input.jobName ?? null,
          state: 'running',
          attempts: 1,
          maxAttempts: input.maxAttempts,
          leaseToken: token,
          leaseUntil: leaseUntil(input.leaseMs),
          startedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: [jobRuns.queue, jobRuns.jobKey],
          set: {
            state: 'running',
            // Nova execução depois de um desfecho recomeça em 1; tentativa seguinte (retry,
            // worker que morreu, lost) soma 1.
            attempts: sql`CASE WHEN ${fresh} THEN 1 ELSE ${jobRuns.attempts} + 1 END`,
            maxAttempts: input.maxAttempts,
            leaseToken: token,
            leaseUntil: leaseUntil(input.leaseMs),
            jobName: sql`COALESCE(excluded.job_name, ${jobRuns.jobName})`,
            startedAt: sql`CASE WHEN ${fresh} OR ${jobRuns.startedAt} IS NULL THEN now() ELSE ${jobRuns.startedAt} END`,
            finishedAt: null,
            updatedAt: sql`now()`,
          },
        })
        .returning({ attempts: jobRuns.attempts });
      return { queue: input.queue, jobKey: input.jobKey, token, attempts: rows[0]?.attempts ?? 1 };
    },

    async heartbeat(lease, leaseMs) {
      const rows = await db
        .update(jobRuns)
        .set({ leaseUntil: leaseUntil(leaseMs), updatedAt: sql`now()` })
        .where(and(leaseWhere(lease), eq(jobRuns.state, 'running')))
        .returning({ id: jobRuns.id });
      return rows.length > 0;
    },

    async succeed(lease, result) {
      const rows = await db
        .update(jobRuns)
        .set({
          state: 'succeeded',
          leaseToken: null,
          leaseUntil: null,
          errorKind: null,
          errorCode: null,
          lastError: null,
          result: result === undefined ? null : (result as Record<string, unknown>),
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(leaseWhere(lease))
        .returning({ id: jobRuns.id });
      return rows.length > 0;
    },

    async fail(lease, input: FailInput) {
      const rows = await db
        .update(jobRuns)
        .set({
          state: input.state,
          leaseToken: null,
          leaseUntil: null,
          errorKind: input.errorKind,
          errorCode: input.errorCode,
          lastError: input.lastError,
          finishedAt: input.state === 'retrying' ? null : sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(leaseWhere(lease))
        .returning({ id: jobRuns.id });
      return rows.length > 0;
    },

    async get(key) {
      const rows = await db.select().from(jobRuns).where(keyWhere(key)).limit(1);
      return rows[0] ? toRun(rows[0]) : null;
    },

    async list(filter: ListFilter = {}) {
      const conditions: SQL[] = [];
      if (filter.states?.length) conditions.push(inArray(jobRuns.state, [...filter.states]));
      if (filter.queue) conditions.push(eq(jobRuns.queue, filter.queue));
      const rows = await db
        .select()
        .from(jobRuns)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(jobRuns.createdAt))
        .limit(filter.limit ?? 100);
      return rows.map(toRun);
    },

    async gcPlan(criteria: GcCriteria) {
      const count = sql<number>`count(*)::int`;
      const deletions = await db
        .select({ queue: jobRuns.queue, state: jobRuns.state, count })
        .from(jobRuns)
        .where(gcDeleteWhere(criteria))
        .groupBy(jobRuns.queue, jobRuns.state);
      const lost = await db
        .select({ queue: jobRuns.queue, state: jobRuns.state, count })
        .from(jobRuns)
        .where(gcLostWhere(criteria))
        .groupBy(jobRuns.queue, jobRuns.state);
      const plan: GcPlanRow[] = [
        ...deletions.map((row) => ({ ...row, state: row.state as JobRunState, action: 'delete' as const })),
        ...lost.map((row) => ({ ...row, state: row.state as JobRunState, action: 'mark_lost' as const })),
      ];
      return plan.sort((a, b) => a.queue.localeCompare(b.queue) || a.state.localeCompare(b.state));
    },

    async gcApply(criteria: GcCriteria) {
      const deleted = await db.delete(jobRuns).where(gcDeleteWhere(criteria)).returning({ id: jobRuns.id });
      const lost = await db
        .update(jobRuns)
        .set({ state: 'lost', leaseToken: null, finishedAt: sql`now()`, updatedAt: sql`now()` })
        .where(gcLostWhere(criteria))
        .returning({ id: jobRuns.id });
      return { deleted: deleted.length, markedLost: lost.length };
    },
  };
  return store;
}

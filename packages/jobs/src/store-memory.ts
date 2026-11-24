// Story 18.3 · JobRunStore em memória — mesma semântica do Drizzle (testes de unidade/processors).
import { randomUUID } from 'node:crypto';

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
import { TERMINAL_STATES, type JobRun, type JobRunKey } from './types.js';

export interface MemoryJobRunStore extends JobRunStore {
  /** Linhas atuais (cópias). */
  rows(): JobRun[];
  /** Relógio injetável (testes de lease/GC). */
  now: () => Date;
}

const keyOf = (key: JobRunKey): string => `${key.queue}\u0000${key.jobKey}`;

export function createMemoryJobRunStore(options: { now?: () => Date } = {}): MemoryJobRunStore {
  const table = new Map<string, JobRun>();
  const store: MemoryJobRunStore = {
    now: options.now ?? (() => new Date()),
    rows: () => [...table.values()].map((row) => ({ ...row })),

    async reserve(input: ReserveInput): Promise<ReserveResult> {
      const now = store.now();
      const existing = table.get(keyOf(input));
      if (existing && isLive(existing, now, input)) return { reserved: false, run: { ...existing } };
      const run: JobRun = {
        id: existing?.id ?? randomUUID(),
        storeId: input.storeId ?? existing?.storeId ?? 'default',
        queue: input.queue,
        jobKey: input.jobKey,
        jobName: input.jobName ?? existing?.jobName ?? null,
        state: 'queued',
        attempts: 0,
        maxAttempts: input.maxAttempts,
        leaseToken: null,
        leaseUntil: null,
        errorKind: null,
        errorCode: null,
        lastError: null,
        correlationId: input.correlationId ?? null,
        result: null,
        replay: input.replay ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      };
      table.set(keyOf(input), run);
      return { reserved: true, run: { ...run } };
    },

    async markQueuedFailed(key, error) {
      const row = table.get(keyOf(key));
      if (!row || row.state !== 'queued') return false;
      Object.assign(row, {
        state: 'queued_failed',
        errorKind: 'transient',
        errorCode: error.errorCode,
        lastError: error.lastError,
        updatedAt: store.now(),
      });
      return true;
    },

    async begin(input: BeginInput): Promise<JobLease> {
      const now = store.now();
      const token = randomUUID();
      const leaseUntil = new Date(now.getTime() + input.leaseMs);
      const row = table.get(keyOf(input));
      if (!row) {
        const run: JobRun = {
          id: randomUUID(),
          storeId: input.storeId ?? 'default',
          queue: input.queue,
          jobKey: input.jobKey,
          jobName: input.jobName ?? null,
          state: 'running',
          attempts: 1,
          maxAttempts: input.maxAttempts,
          leaseToken: token,
          leaseUntil,
          errorKind: null,
          errorCode: null,
          lastError: null,
          correlationId: null,
          result: null,
          replay: null,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
          finishedAt: null,
        };
        table.set(keyOf(input), run);
        return { queue: input.queue, jobKey: input.jobKey, token, attempts: 1 };
      }
      const fresh = row.state === 'succeeded' || row.state === 'failed' || row.state === 'uncertain';
      Object.assign(row, {
        state: 'running',
        attempts: fresh ? 1 : row.attempts + 1,
        maxAttempts: input.maxAttempts,
        leaseToken: token,
        leaseUntil,
        jobName: input.jobName ?? row.jobName,
        startedAt: fresh || !row.startedAt ? now : row.startedAt,
        finishedAt: null,
        updatedAt: now,
      });
      return { queue: input.queue, jobKey: input.jobKey, token, attempts: row.attempts };
    },

    async heartbeat(lease, leaseMs) {
      const row = table.get(keyOf(lease));
      if (!row || row.leaseToken !== lease.token || row.state !== 'running') return false;
      const now = store.now();
      Object.assign(row, { leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now });
      return true;
    },

    async succeed(lease, result) {
      const row = table.get(keyOf(lease));
      if (!row || row.leaseToken !== lease.token) return false;
      const now = store.now();
      Object.assign(row, {
        state: 'succeeded',
        leaseToken: null,
        leaseUntil: null,
        errorKind: null,
        errorCode: null,
        lastError: null,
        result: result === undefined ? null : result,
        finishedAt: now,
        updatedAt: now,
      });
      return true;
    },

    async fail(lease, input: FailInput) {
      const row = table.get(keyOf(lease));
      if (!row || row.leaseToken !== lease.token) return false;
      const now = store.now();
      Object.assign(row, {
        state: input.state,
        leaseToken: null,
        leaseUntil: null,
        errorKind: input.errorKind,
        errorCode: input.errorCode,
        lastError: input.lastError,
        finishedAt: input.state === 'retrying' ? null : now,
        updatedAt: now,
      });
      return true;
    },

    async get(key) {
      const row = table.get(keyOf(key));
      return row ? { ...row } : null;
    },

    async list(filter: ListFilter = {}) {
      return store
        .rows()
        .filter((row) => (!filter.states || filter.states.includes(row.state)) && (!filter.queue || row.queue === filter.queue))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, filter.limit ?? 100);
    },

    async gcPlan(criteria: GcCriteria) {
      const plan = new Map<string, GcPlanRow>();
      for (const row of table.values()) {
        const action = gcAction(row, criteria);
        if (!action) continue;
        const id = `${row.queue}|${row.state}|${action}`;
        const entry = plan.get(id) ?? { queue: row.queue, state: row.state, action, count: 0 };
        entry.count += 1;
        plan.set(id, entry);
      }
      return [...plan.values()].sort((a, b) => a.queue.localeCompare(b.queue) || a.state.localeCompare(b.state));
    },

    async gcApply(criteria: GcCriteria) {
      let deleted = 0;
      let markedLost = 0;
      const now = store.now();
      for (const [id, row] of table) {
        const action = gcAction(row, criteria);
        if (action === 'delete') {
          table.delete(id);
          deleted += 1;
        } else if (action === 'mark_lost') {
          Object.assign(row, { state: 'lost', leaseToken: null, finishedAt: now, updatedAt: now });
          markedLost += 1;
        }
      }
      return { deleted, markedLost };
    },
  };
  return store;
}

/** Linha viva (não reabre) — mesma regra do `setWhere` do store Drizzle. */
function isLive(row: JobRun, now: Date, input: ReserveInput): boolean {
  const staleRunning = input.staleRunningMs ?? STALE_RUNNING_MS;
  const staleQueued = input.staleQueuedMs ?? STALE_QUEUED_MS;
  if (row.state === 'running') return !row.leaseUntil || row.leaseUntil.getTime() >= now.getTime() - staleRunning;
  if (row.state === 'queued' || row.state === 'retrying') return row.updatedAt.getTime() >= now.getTime() - staleQueued;
  return false;
}

function gcAction(row: JobRun, criteria: GcCriteria): GcPlanRow['action'] | null {
  if (row.state === 'running') {
    return row.leaseUntil && row.leaseUntil < criteria.leaseExpiredBefore ? 'mark_lost' : null;
  }
  if (!TERMINAL_STATES.includes(row.state) || !row.finishedAt) return null;
  const limit = row.state === 'succeeded' ? criteria.succeededBefore : criteria.failedBefore;
  return row.finishedAt < limit ? 'delete' : null;
}

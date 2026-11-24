// @blackshop/jobs/gc — limpeza do ledger com dry-run por padrão (C11).
//
// Apaga desfechos antigos (succeeded > 30 dias; failed/uncertain/lost > 90 dias — sugestão,
// ajustável sem nova story) e marca `lost` as execuções `running` cujo lease venceu há mais de
// `lostAfterMs` (padrão 2 × lease de 30 s). Nunca toca `queued`, `queued_failed` nem `retrying`.
import type { GcCriteria, GcPlanRow, JobRunStore } from './store-types.js';

export interface GcOptions {
  succeededOlderThanDays?: number;
  failedOlderThanDays?: number;
  /** Tolerância depois do fim do lease antes de marcar `lost`. Padrão 60 s (2 × 30 s). */
  lostAfterMs?: number;
  /** Padrão true: só calcula o plano. */
  dryRun?: boolean;
  now?: Date;
}

export interface GcReport {
  dryRun: boolean;
  criteria: GcCriteria;
  plan: GcPlanRow[];
  deleted: number;
  markedLost: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const GC_DEFAULTS = { succeededOlderThanDays: 30, failedOlderThanDays: 90, lostAfterMs: 60_000 } as const;

export async function gcJobRuns(store: JobRunStore, options: GcOptions = {}): Promise<GcReport> {
  const now = options.now ?? new Date();
  const succeededDays = options.succeededOlderThanDays ?? GC_DEFAULTS.succeededOlderThanDays;
  const failedDays = options.failedOlderThanDays ?? GC_DEFAULTS.failedOlderThanDays;
  for (const [name, value] of [
    ['succeededOlderThanDays', succeededDays],
    ['failedOlderThanDays', failedDays],
  ] as const) {
    if (!Number.isFinite(value) || value < 1) throw new Error(`gcJobRuns: ${name} deve ser >= 1 (recebido ${value})`);
  }
  const criteria: GcCriteria = {
    succeededBefore: new Date(now.getTime() - succeededDays * DAY_MS),
    failedBefore: new Date(now.getTime() - failedDays * DAY_MS),
    leaseExpiredBefore: new Date(now.getTime() - (options.lostAfterMs ?? GC_DEFAULTS.lostAfterMs)),
  };
  const dryRun = options.dryRun ?? true;
  const plan = await store.gcPlan(criteria);
  if (dryRun) return { dryRun, criteria, plan, deleted: 0, markedLost: 0 };
  const applied = await store.gcApply(criteria);
  return { dryRun, criteria, plan, ...applied };
}

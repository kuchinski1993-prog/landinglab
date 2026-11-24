// Story 18.3 · Contrato do ledger (JobRunStore). Duas implementações com a mesma semântica:
// memória (testes) e Drizzle sobre @blackshop/db (produção; testada com Postgres real/PGlite).
import type { JobErrorKind, JobRun, JobRunKey, JobRunState } from './types.js';

export interface ReserveInput extends JobRunKey {
  jobName?: string;
  maxAttempts: number;
  storeId?: string;
  correlationId?: string;
  /** Flags mínimas para o reconcile (nunca dados do cliente). */
  replay?: Record<string, unknown>;
  /**
   * Linha `running` com lease vencido há mais que isto é órfã (worker morreu e o BullMQ desistiu)
   * e pode ser reaberta. Padrão 60 s (2 × lease de 30 s).
   */
  staleRunningMs?: number;
  /** Linha `queued`/`retrying` sem atualização há mais que isto é órfã. Padrão 1 h. */
  staleQueuedMs?: number;
}

export const STALE_RUNNING_MS = 60_000;
export const STALE_QUEUED_MS = 60 * 60 * 1000;

export interface ReserveResult {
  /** true = linha criada (ou reaberta de um desfecho/queued_failed) e o job deve ser enfileirado. */
  reserved: boolean;
  run: JobRun;
}

export interface BeginInput extends JobRunKey {
  leaseMs: number;
  maxAttempts: number;
  jobName?: string;
  storeId?: string;
}

/** Posse da execução: só quem tem o token grava (fencing). */
export interface JobLease extends JobRunKey {
  token: string;
  attempts: number;
}

export interface FailInput {
  state: 'retrying' | 'failed' | 'uncertain';
  errorKind: JobErrorKind;
  errorCode: string | null;
  lastError: string | null;
}

export interface ListFilter {
  states?: readonly JobRunState[];
  queue?: string;
  limit?: number;
}

export interface GcCriteria {
  /** succeeded com finished_at anterior a isto → apagar. */
  succeededBefore: Date;
  /** failed/uncertain/lost com finished_at anterior a isto → apagar. */
  failedBefore: Date;
  /** running com lease_until anterior a isto → marcar lost. */
  leaseExpiredBefore: Date;
}

export interface GcPlanRow {
  queue: string;
  state: JobRunState;
  action: 'delete' | 'mark_lost';
  count: number;
}

export interface JobRunStore {
  /**
   * Enfileiramento idempotente: cria `queued`; reabre desfecho/queued_failed e órfãos (running com
   * lease vencido > staleRunningMs; queued/retrying parado > staleQueuedMs); linha viva → reserved=false.
   */
  reserve(input: ReserveInput): Promise<ReserveResult>;
  /** `queued` → `queued_failed` (o queue.add falhou). */
  markQueuedFailed(key: JobRunKey, error: { errorCode: string; lastError: string | null }): Promise<boolean>;
  /** Inicia uma tentativa: novo lease_token, attempts + 1 (ou 1 se a linha estava num desfecho). */
  begin(input: BeginInput): Promise<JobLease>;
  heartbeat(lease: JobLease, leaseMs: number): Promise<boolean>;
  succeed(lease: JobLease, result?: unknown): Promise<boolean>;
  fail(lease: JobLease, input: FailInput): Promise<boolean>;
  get(key: JobRunKey): Promise<JobRun | null>;
  list(filter?: ListFilter): Promise<JobRun[]>;
  gcPlan(criteria: GcCriteria): Promise<GcPlanRow[]>;
  gcApply(criteria: GcCriteria): Promise<{ deleted: number; markedLost: number }>;
}

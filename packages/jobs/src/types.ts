// Story 18.3 · Tipos do ledger de jobs duráveis (tabela job_runs, migration 0097).

export const JOB_RUN_STATES = [
  'queued',
  'queued_failed',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'uncertain',
  'lost',
] as const;

export type JobRunState = (typeof JOB_RUN_STATES)[number];

/** Desfechos: a linha só sai daqui por um novo enqueue (reserve) ou uma nova execução (begin). */
export const TERMINAL_STATES: readonly JobRunState[] = ['succeeded', 'failed', 'uncertain', 'lost'];

/** Estados "vivos": um novo enqueue com o mesmo jobKey não cria outro job. */
export const ACTIVE_STATES: readonly JobRunState[] = ['queued', 'running', 'retrying'];

export type JobErrorKind = 'deterministic' | 'transient' | 'uncertain';

export interface JobRunKey {
  queue: string;
  jobKey: string;
}

export interface JobRun extends JobRunKey {
  id: string;
  storeId: string;
  jobName: string | null;
  state: JobRunState;
  attempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  leaseUntil: Date | null;
  errorKind: JobErrorKind | null;
  errorCode: string | null;
  lastError: string | null;
  correlationId: string | null;
  result: unknown;
  /** Flags mínimas gravadas no enqueue para o reconcile reconstruir o job (nunca dados do cliente). */
  replay: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Classificação de uma falha (ver classifyJobError). */
export interface JobErrorClassification {
  kind: JobErrorKind;
  /** Código estável (catálogo 18.1, `UPSTREAM_*` ou `plataforma.job_unclassified`). */
  code: string;
  /** Mensagem sanitizada (≤ 500), sem payload. */
  message: string;
  /** true quando nenhuma regra reconheceu o erro (transitório por precaução). */
  unclassified: boolean;
}

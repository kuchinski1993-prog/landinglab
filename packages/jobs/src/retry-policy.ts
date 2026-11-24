// Story 18.3 · Regra de estado final: só `failed` no erro determinístico ou na ÚLTIMA tentativa.
// O BullMQ continua aplicando o backoff; esta regra só decide o que o ledger/logger registram e
// se o wrapper relança como UnrecoverableError (sem retry) ou com o erro original (retry).
import type { JobErrorKind } from './types.js';

/** Campos do job do BullMQ usados pela regra (permite job simulado nos testes). */
export interface AttemptInfo {
  /** Tentativas que JÁ falharam antes desta (BullMQ ≥ 5: 0 na primeira execução). */
  attemptsMade: number;
  opts?: { attempts?: number };
}

export interface RetryDecision {
  /** Estado do ledger depois desta falha. */
  state: 'failed' | 'retrying' | 'uncertain';
  /** O BullMQ deve repetir? (false → relançar UnrecoverableError). */
  retry: boolean;
}

function maxAttemptsOf(job: AttemptInfo): number {
  const attempts = job.opts?.attempts;
  return typeof attempts === 'number' && attempts >= 1 ? Math.floor(attempts) : 1;
}

function isLastAttempt(job: AttemptInfo): boolean {
  return job.attemptsMade + 1 >= maxAttemptsOf(job);
}

function decide(kind: JobErrorKind, lastAttempt: boolean): RetryDecision {
  if (kind === 'deterministic') return { state: 'failed', retry: false };
  if (kind === 'uncertain') return { state: 'uncertain', retry: false };
  return lastAttempt ? { state: 'failed', retry: false } : { state: 'retrying', retry: true };
}

export const RetryPolicy = { maxAttemptsOf, isLastAttempt, decide } as const;

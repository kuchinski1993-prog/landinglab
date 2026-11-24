// Story 18.3 · Erros tipados dos jobs duráveis.
import { AppError } from '@blackshop/errors';
import { UnrecoverableError } from 'bullmq';

import { JOB_ERRORS } from './catalog.js';

/**
 * Falha de regra/validação: repetir não adianta. Estende `UnrecoverableError`, então mesmo
 * lançado por um processor que ainda NÃO usa o wrapper o BullMQ não repete.
 * O `name` fica 'UnrecoverableError' (o BullMQ também reconhece pelo nome).
 */
export class DeterministicJobError extends UnrecoverableError {
  readonly jobErrorKind = 'deterministic' as const;
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'UnrecoverableError';
    this.code = code;
    this.details = details;
  }
}

/** Falha passageira com código próprio (ex.: enfileirar o passo seguinte falhou): o BullMQ repete. */
export class TransientJobError extends Error {
  readonly jobErrorKind = 'transient' as const;
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TransientJobError';
    this.code = code;
  }
}

/**
 * O enfileiramento falhou (Redis fora): a linha do ledger ficou em `queued_failed`.
 * `AppError` do catálogo → a API responde 503 `plataforma.job_enqueue_failed`.
 */
export class JobEnqueueError extends AppError {
  constructor(details?: { queue: string; jobKey: string }, cause?: unknown) {
    const entry = JOB_ERRORS.entries['plataforma.job_enqueue_failed'];
    super(entry.message, entry.status, 'plataforma.job_enqueue_failed', details, { cause });
    this.name = 'JobEnqueueError';
  }
}

/** Relançado pelo wrapper quando o handler lança algo que não é `Error` (string, undefined…). */
export class JobThrewNonError extends Error {
  constructor(value: unknown) {
    super(`job lançou um valor que não é Error (${value === null ? 'null' : typeof value})`);
    this.name = 'JobThrewNonError';
  }
}

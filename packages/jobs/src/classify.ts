// Story 18.3 · Classificação de falhas de job: determinístico × transitório × incerto (C10).
//
// Ordem (Decisão 4 da story):
//   0. mapa do processor (`classify` opcional) — quando devolve um `kind`, vale ele;
//   a. UnrecoverableError do BullMQ, DeterministicJobError, `kind: 'permanent'` → deterministic;
//   b. `kind: 'uncertain'` (UpstreamError da 18.2) ou `uncertain: true` (UpstreamTimeoutError) → uncertain;
//   c. `kind: 'transient'`, TransientJobError, rede, 5xx, 429, timeout não incerto → transient;
//   d. desconhecido → transient (até a última tentativa) + `plataforma.job_unclassified`.
// Reutiliza a classificação da 18.2 por forma (`kind`/`uncertain`), sem `instanceof` entre
// pacotes — vale também para erros vindos de pacotes compilados (dist).
import { UnrecoverableError } from 'bullmq';

import { messageOf, sanitizeErrorText } from './sanitize.js';
import type { JobErrorClassification, JobErrorKind } from './types.js';

export const UNCLASSIFIED_CODE = 'plataforma.job_unclassified';

/** Códigos de erro de rede do Node/undici que valem repetir. */
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
]);

const TRANSIENT_NAMES = new Set(['AbortError', 'TimeoutError', 'FetchError']);

export type ProcessorClassifier = (
  err: unknown,
) => { kind: JobErrorKind; code?: string } | null | undefined;

export interface ClassifyOptions {
  /** Mapa do processor: decide antes das regras genéricas. */
  classify?: ProcessorClassifier;
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function stringCode(value: unknown): string | undefined {
  const code = field(value, 'code');
  return typeof code === 'string' && code.trim() ? code : undefined;
}

function httpStatus(value: unknown): number | undefined {
  for (const key of ['statusCode', 'status']) {
    const status = field(value, key);
    if (typeof status === 'number' && Number.isInteger(status)) return status;
  }
  return undefined;
}

function genericKind(err: unknown): JobErrorKind | undefined {
  const marker = field(err, 'jobErrorKind');
  if (marker === 'deterministic' || marker === 'transient' || marker === 'uncertain') return marker;
  if (err instanceof UnrecoverableError || field(err, 'name') === 'UnrecoverableError') return 'deterministic';
  const kind = field(err, 'kind');
  if (kind === 'permanent') return 'deterministic';
  if (kind === 'uncertain' || field(err, 'uncertain') === true) return 'uncertain';
  if (kind === 'transient') return 'transient';
  const code = stringCode(err);
  if (code && NETWORK_CODES.has(code)) return 'transient';
  const name = field(err, 'name');
  if (typeof name === 'string' && TRANSIENT_NAMES.has(name)) return 'transient';
  const status = httpStatus(err);
  if (status !== undefined && (status === 429 || (status >= 500 && status <= 599))) return 'transient';
  // undici: `TypeError: fetch failed` com a causa de rede em `cause`.
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return 'transient';
  const cause = field(err, 'cause');
  if (cause !== undefined && cause !== err) {
    const causeCode = stringCode(cause);
    if (causeCode && NETWORK_CODES.has(causeCode)) return 'transient';
  }
  return undefined;
}

export function classifyJobError(err: unknown, options: ClassifyOptions = {}): JobErrorClassification {
  const ownCode = stringCode(err);
  const raw = messageOf(err);
  const fromProcessor = options.classify?.(err);
  if (fromProcessor) {
    const code = fromProcessor.code ?? ownCode ?? UNCLASSIFIED_CODE;
    return { kind: fromProcessor.kind, code, message: sanitizeErrorText(raw), unclassified: false };
  }
  const kind = genericKind(err);
  if (kind) {
    return { kind, code: ownCode ?? UNCLASSIFIED_CODE, message: sanitizeErrorText(raw), unclassified: false };
  }
  // d. Desconhecido: transitório por precaução (não perder trabalho por classificação errada);
  //    o código original (se houver) vai na mensagem para a equipe classificar depois.
  const message = ownCode ? `[${ownCode}] ${raw}` : raw;
  return { kind: 'transient', code: UNCLASSIFIED_CODE, message: sanitizeErrorText(message), unclassified: true };
}

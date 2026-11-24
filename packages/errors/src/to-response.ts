// Converte qualquer erro em { status, body } no padrão { code, message, details?, error }.
// Núcleo puro: sem Fastify, sem banco, sem @blackshop/shared (legados reconhecidos por err.code).
import { AppError } from './app-error.js';
import { buildBody, type AnyCatalog, type ErrorBody, type ErrorEntry } from './catalog.js';
import { COMMON_CATALOG } from './common.js';

export interface ToErrorResponseOptions {
  /** Catálogos do módulo, consultados antes do comum. */
  catalogs?: readonly AnyCatalog[];
  /**
   * `'vsl'`: reproduz exatamente o contrato do VSL Hosting (G3) — status do VslError, mensagem
   * livre do erro, fallback por status com códigos do VSL, 429 → validation_failed, sem ramo
   * para UPSTREAM_*. Só o VSL usa; handlers novos usam o padrão.
   */
  compat?: 'vsl';
}

export interface ErrorResponse {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
  /** AppError com `code` fora dos catálogos: o handler loga `error_code_not_in_catalog`. */
  unknownCode?: boolean;
  /** Erro não reconhecido (500 internal_error): o handler loga o erro real. */
  unexpected?: boolean;
}

interface ErrorLike {
  code?: unknown;
  statusCode?: unknown;
  validation?: unknown;
  retryAfterMs?: unknown;
  cause?: { code?: unknown } | null;
}

const PG_CONSTRAINT = new Set(['23505', '23503', '23514']);

function lookup(code: string, catalogs: readonly AnyCatalog[], withCommon: boolean): ErrorEntry | undefined {
  for (const catalog of catalogs) {
    const entry = catalog.get(code);
    if (entry) return entry;
  }
  return withCommon ? COMMON_CATALOG.get(code) : undefined;
}

function respond(code: string, catalogs: readonly AnyCatalog[], status?: number, details?: unknown): ErrorResponse {
  const entry = lookup(code, catalogs, true) ?? COMMON_CATALOG.entries.internal_error;
  return { status: status ?? entry.status, body: buildBody(code, entry.message, details, entry) };
}

// Ramo padrão. 400/406/422 e demais 4xx não listados → validation_failed (regra em erros.md).
function codeForStatus(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 405) return 'method_not_allowed';
  if (status === 409) return 'constraint_conflict';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'service_unavailable';
  return status >= 500 ? 'internal_error' : 'validation_failed';
}

function vslCodeForStatus(status: number): string {
  if (status === 404) return 'not_found';
  if (status === 409) return 'constraint_conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 502) return 'stream_unavailable';
  if (status === 503) return 'service_unavailable';
  return status >= 500 ? 'internal_error' : 'validation_failed';
}

function httpStatus(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

function fromPostgres(error: ErrorLike, catalogs: readonly AnyCatalog[]): ErrorResponse | undefined {
  // 22P02 = texto inválido para o tipo (ex.: UUID malformado): erro do cliente, não 500.
  if (error.code === '22P02' || error.cause?.code === '22P02')
    return respond('validation_failed', catalogs, 400, { reason: 'invalid_id' });
  if (typeof error.code === 'string' && PG_CONSTRAINT.has(error.code)) return respond('constraint_conflict', catalogs, 409);
  return undefined;
}

function unexpected(catalogs: readonly AnyCatalog[]): ErrorResponse {
  // Nunca devolve error.message/stack/nome da classe: só a mensagem genérica PT-BR.
  return { ...respond('internal_error', catalogs, 500), unexpected: true };
}

function toVslCompat(error: unknown, catalogs: readonly AnyCatalog[]): ErrorResponse {
  if (error instanceof AppError) {
    const preset = error.code ? lookup(error.code, catalogs, false) : undefined;
    if (preset && error.code) {
      const message = error.message && error.message !== preset.message ? error.message : preset.message;
      return { status: error.statusCode, body: buildBody(error.code, message, error.details) };
    }
    const code = vslCodeForStatus(error.statusCode);
    return { status: error.statusCode, body: buildBody(code, respond(code, catalogs).body.message) };
  }
  const like = (error ?? {}) as ErrorLike;
  if (like.validation) return respond('validation_failed', catalogs, 400, like.validation);
  if (like.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return respond('payload_too_large', catalogs, 413);
  if (like.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return respond('unsupported_media_type', catalogs, 415);
  if (typeof like.statusCode === 'number' && like.statusCode >= 400 && like.statusCode < 500)
    return respond(like.statusCode === 404 ? 'not_found' : 'validation_failed', catalogs, like.statusCode);
  return fromPostgres(like, catalogs) ?? unexpected(catalogs);
}

function fromAppError(error: AppError, catalogs: readonly AnyCatalog[]): ErrorResponse {
  const status = httpStatus(error.statusCode);
  if (error.code) {
    const entry = lookup(error.code, catalogs, true);
    if (entry) {
      const message = error.publicMessage && error.message.trim() ? error.message : entry.message;
      return { status: entry.status, body: buildBody(error.code, message, error.details, entry) };
    }
    // Código fora de qualquer catálogo: mantém status e code, mas nunca a mensagem livre.
    const generic = respond(codeForStatus(status), catalogs).body.message;
    return { status, body: buildBody(error.code, generic, error.details), unknownCode: true };
  }
  const code = codeForStatus(status);
  return respond(code, catalogs, status, error.details);
}

function fromLegacyUpstream(like: ErrorLike, catalogs: readonly AnyCatalog[]): ErrorResponse | undefined {
  if (like.code === 'UPSTREAM_TIMEOUT') return respond('UPSTREAM_TIMEOUT', catalogs);
  // Story 18.2: 5xx/rede esgotados e 4xx recusados pelo terceiro.
  if (like.code === 'UPSTREAM_UNAVAILABLE') return respond('UPSTREAM_UNAVAILABLE', catalogs);
  if (like.code === 'UPSTREAM_REJECTED') return respond('UPSTREAM_REJECTED', catalogs);
  if (like.code !== 'UPSTREAM_RATE_LIMITED') return undefined;
  const ms = like.retryAfterMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return respond('UPSTREAM_RATE_LIMITED', catalogs);
  const retryAfterSeconds = Math.ceil(ms / 1000);
  return {
    ...respond('UPSTREAM_RATE_LIMITED', catalogs, undefined, { retryAfterSeconds }),
    headers: { 'retry-after': String(retryAfterSeconds) },
  };
}

export function toErrorResponse(error: unknown, options: ToErrorResponseOptions = {}): ErrorResponse {
  const catalogs = options.catalogs ?? [];
  if (options.compat === 'vsl') return toVslCompat(error, catalogs);
  if (error instanceof AppError) return fromAppError(error, catalogs);
  const like = (error !== null && typeof error === 'object' ? error : {}) as ErrorLike;
  const legacy = fromLegacyUpstream(like, catalogs);
  if (legacy) return legacy;
  if (like.validation) return respond('validation_failed', catalogs, 400, like.validation);
  if (like.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
    return respond('validation_failed', catalogs, 413, { reason: 'payload_too_large' });
  if (like.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
    return respond('validation_failed', catalogs, 415, { reason: 'unsupported_media_type' });
  if (typeof like.statusCode === 'number' && like.statusCode >= 400 && like.statusCode < 500)
    return respond(codeForStatus(like.statusCode), catalogs, like.statusCode);
  return fromPostgres(like, catalogs) ?? unexpected(catalogs);
}

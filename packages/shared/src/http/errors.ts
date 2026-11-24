// Story 18.2 · erros classificados das chamadas a terceiros (`@blackshop/shared/http`).
//
// Toda falha de transporte sai como `UpstreamError` com `kind`:
//   - `transient`: pode ser repetida mais tarde (429, 5xx/rede/timeout em chamada idempotente);
//   - `permanent`: não adianta repetir (4xx ≠ 429);
//   - `uncertain`: a operação PODE ter sido processada (não idempotente com timeout/5xx/rede) —
//     o chamador nunca reenvia às cegas; reconcilia (story 18.3).
// `UpstreamTimeoutError` e `UpstreamRateLimitedError` mantêm construtor, campos e mensagens da 0.8.
// Mensagens nunca incluem URL, token, corpo de requisição ou de resposta.

export type UpstreamErrorKind = 'transient' | 'permanent' | 'uncertain';

export type UpstreamErrorCode =
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_REJECTED';

const UNCERTAIN_SUFFIX = ' (resultado incerto: a operação pode ter sido processada)';

export abstract class UpstreamError extends Error {
  abstract readonly code: UpstreamErrorCode;
  /** Status HTTP para servidores (Fastify usa `statusCode` do erro). */
  abstract readonly statusCode: number;
  abstract readonly kind: UpstreamErrorKind;
  /** Nome do serviço (ex.: `shopify-admin`). Nunca a URL. */
  readonly label: string;
  /** Tentativas feitas até a falha. */
  readonly attempts: number;

  protected constructor(message: string, label: string, attempts: number, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.label = label;
    this.attempts = attempts;
  }
}

/**
 * A chamada não respondeu dentro do prazo. `uncertain = true` quando a requisição PODE ter
 * sido processada pelo terceiro (mutations, criação de carrinho, envio de evento) — nesses
 * casos o chamador nunca retenta às cegas. `uncertain = false` (consultas, renovação de
 * token) pode ser retentado.
 */
export class UpstreamTimeoutError extends UpstreamError {
  readonly code = 'UPSTREAM_TIMEOUT' as const;
  /** 504 Gateway Timeout. */
  readonly statusCode = 504;
  readonly timeoutMs: number;
  readonly uncertain: boolean;

  constructor(label: string, timeoutMs: number, uncertain: boolean, attempts = 1) {
    super(`${label}: sem resposta em ${timeoutMs} ms` + (uncertain ? UNCERTAIN_SUFFIX : ''), label, attempts);
    this.name = 'UpstreamTimeoutError';
    this.timeoutMs = timeoutMs;
    this.uncertain = uncertain;
  }

  get kind(): UpstreamErrorKind {
    return this.uncertain ? 'uncertain' : 'transient';
  }
}

/**
 * O terceiro respondeu 429 e as tentativas se esgotaram. Story 18.2: `statusCode = 503` — do
 * ponto de vista do cliente da BlackShop é indisponibilidade do nosso serviço (o 429 da própria
 * BlackShop é outro código, `rate_limited`).
 */
export class UpstreamRateLimitedError extends UpstreamError {
  readonly code = 'UPSTREAM_RATE_LIMITED' as const;
  readonly statusCode = 503;
  readonly kind = 'transient' as const;
  /** Espera pedida pelo último `Retry-After` (null se ausente/ilegível). */
  readonly retryAfterMs: number | null;

  constructor(label: string, retryAfterMs: number | null, attempts: number) {
    super(
      `${label}: limite de requisições (429) após ${attempts} tentativa(s)` +
        (retryAfterMs !== null ? `; Retry-After ${retryAfterMs} ms` : ''),
      label,
      attempts,
    );
    this.name = 'UpstreamRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface UpstreamUnavailableErrorOptions {
  label: string;
  /** Status 5xx da última resposta; `null` = falha de rede (sem resposta). */
  status: number | null;
  attempts: number;
  /** `uncertain` em chamada não idempotente (não repetida); `transient` no resto. */
  kind: 'transient' | 'uncertain';
  /** Erro de rede original (só em `status: null`). */
  cause?: unknown;
  /** Mensagem preservada de um contrato anterior (nunca com URL/token/corpo). */
  message?: string;
}

/** 5xx ou falha de rede depois das tentativas permitidas. */
export class UpstreamUnavailableError extends UpstreamError {
  readonly code = 'UPSTREAM_UNAVAILABLE' as const;
  readonly statusCode = 503;
  readonly kind: 'transient' | 'uncertain';
  readonly status: number | null;

  constructor(options: UpstreamUnavailableErrorOptions) {
    const { label, status, attempts, kind } = options;
    const what = status === null ? 'falha de rede' : `serviço indisponível (HTTP ${status})`;
    super(
      options.message ??
        `${label}: ${what} após ${attempts} tentativa(s)` + (kind === 'uncertain' ? UNCERTAIN_SUFFIX : ''),
      label,
      attempts,
      { cause: options.cause },
    );
    this.name = 'UpstreamUnavailableError';
    this.kind = kind;
    this.status = status;
  }
}

export interface UpstreamRejectedErrorOptions {
  label: string;
  status: number;
  attempts: number;
  /** Mensagem preservada de um contrato anterior (nunca com URL/token/corpo). */
  message?: string;
}

/** 4xx (≠ 429): o terceiro recusou; repetir não adianta. */
export class UpstreamRejectedError extends UpstreamError {
  readonly code = 'UPSTREAM_REJECTED' as const;
  /** 502 Bad Gateway: a falha é da integração, não da requisição do cliente da BlackShop. */
  readonly statusCode = 502;
  readonly kind = 'permanent' as const;
  readonly status: number;
  readonly details: { status: number };

  constructor(options: UpstreamRejectedErrorOptions) {
    const { label, status, attempts } = options;
    super(options.message ?? `${label}: requisição recusada (HTTP ${status})`, label, attempts);
    this.name = 'UpstreamRejectedError';
    this.status = status;
    this.details = { status };
  }
}

export function isUpstreamError(err: unknown): err is UpstreamError {
  return err instanceof UpstreamError;
}

export function isUpstreamTimeoutError(err: unknown): err is UpstreamTimeoutError {
  return err instanceof UpstreamTimeoutError;
}

export function isUpstreamRateLimitedError(err: unknown): err is UpstreamRateLimitedError {
  return err instanceof UpstreamRateLimitedError;
}

export function isUpstreamUnavailableError(err: unknown): err is UpstreamUnavailableError {
  return err instanceof UpstreamUnavailableError;
}

export function isUpstreamRejectedError(err: unknown): err is UpstreamRejectedError {
  return err instanceof UpstreamRejectedError;
}

/** O resultado da operação no terceiro é desconhecido (nunca reenviar sem reconciliar). */
export function isUpstreamUncertain(err: unknown): err is UpstreamError {
  return err instanceof UpstreamError && err.kind === 'uncertain';
}

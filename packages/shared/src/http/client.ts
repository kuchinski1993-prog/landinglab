// Story 18.2 · cliente HTTP para chamadas a terceiros: prazo obrigatório, retry com backoff
// exponencial + jitter, respeito ao 429/Retry-After, orçamento total e abort externo.
//
// Regra de segurança do retry (a mais importante):
//   (a) 429 → pode repetir SEMPRE (o terceiro não processou), esperando max(backoff, Retry-After)
//       com teto `maxRetryAfterMs`;
//   (b) 5xx / rede / timeout → repete SÓ se a chamada for idempotente (GET/HEAD/OPTIONS,
//       `idempotent: true` declarado ou header `Idempotency-Key`);
//   (c) não idempotente com 5xx/rede/timeout → NÃO repete: erro `uncertain` para reconciliação;
//   (d) 4xx (≠ 429) → nunca repete (`permanent`).
//
// Cada tentativa usa `fetchWithTimeout` (prazo cobre cabeçalhos E corpo; corpo volta lido).
// Módulo puro (sem node:*, sem banco): serve servidor e bundles Next/Vercel.

import { UpstreamRateLimitedError, UpstreamRejectedError, UpstreamTimeoutError, UpstreamUnavailableError } from './errors.js';
import { fetchWithTimeout, parseRetryAfterMs } from './fetch-with-timeout.js';

export interface HttpRetryOptions {
  /** Total de tentativas (inclui a primeira). Padrão 3. `1` = sem retry. */
  attempts?: number;
  /** Base do backoff exponencial (tentativa n espera base·2^(n-1)). Padrão 500 ms. */
  baseDelayMs?: number;
  /** Teto do backoff (antes do Retry-After). Padrão 8 s. */
  maxDelayMs?: number;
  /** Teto da espera pedida pelo `Retry-After`. Padrão 60 s. */
  maxRetryAfterMs?: number;
  /**
   * Orçamento total (chamadas + esperas): nenhuma espera começa se ultrapassar o orçamento.
   * Padrão `timeoutMs·attempts + (attempts-1)·maxDelayMs`.
   */
  maxTotalMs?: number;
  /** `full` (padrão): espera aleatória em [0, backoff). `none`: backoff exato (clientes legados). */
  jitter?: 'full' | 'none';
  /** Status (≠ 429) tratados como indisponibilidade temporária. Padrão: 500–599. */
  isRetryableStatus?: (status: number) => boolean;
  /**
   * Repetir timeout/erro de rede em chamada idempotente? Padrão `true`. `false` preserva clientes
   * legados que só repetiam respostas HTTP (o prazo total não multiplica).
   */
  retryTransportErrors?: boolean;
}

export type HttpRetryReason = 'rate_limited' | 'server_error' | 'timeout' | 'network';

export interface HttpRetryEvent {
  label: string;
  /** Tentativa que falhou (1 = a primeira). */
  attempt: number;
  /** Espera antes da próxima tentativa. */
  delayMs: number;
  reason: HttpRetryReason;
  /** Status HTTP da resposta que falhou (null em timeout/rede). */
  status: number | null;
  retryAfterMs: number | null;
}

export interface CreateHttpClientOptions {
  /** Nome do serviço para erros e logs (ex.: `shopify-admin`). Nunca a URL. */
  label: string;
  /** Prazo POR TENTATIVA (cabeçalhos + corpo). Obrigatório: não existe cliente sem prazo. */
  timeoutMs: number;
  retry?: HttpRetryOptions;
  /**
   * `throw` (padrão): resposta final de erro vira erro classificado (`UpstreamRateLimitedError`,
   * `UpstreamUnavailableError`, `UpstreamRejectedError`). `return`: o cliente só cuida do
   * transporte e do retry; a resposta final (inclusive 429/5xx/4xx) volta para o chamador
   * mapear no próprio contrato. Timeout e rede sempre viram erro.
   */
  httpErrors?: 'throw' | 'return';
  /** Test seam. Padrão: `fetch` global, resolvido a cada chamada. */
  fetchImpl?: typeof fetch;
  /** Espera entre tentativas. Recebe o `signal` do chamador (a padrão é cancelável). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Fonte do jitter (test seam). Padrão `Math.random`. */
  random?: () => number;
  /** Relógio do orçamento (test seam). Padrão `Date.now`. */
  now?: () => number;
  /** Chamado antes de cada espera de retry (log/progresso). Nunca recebe URL/token. */
  onRetry?: (event: HttpRetryEvent) => void | Promise<void>;
}

export interface HttpRequestOptions {
  /**
   * Repetir 5xx/rede/timeout é seguro? Padrão: GET/HEAD/OPTIONS ou header `Idempotency-Key`.
   * Também decide a incerteza: timeout de chamada não idempotente é `uncertain`.
   */
  idempotent?: boolean;
}

export interface HttpResult {
  response: Response;
  attempts: number;
}

export interface HttpClient {
  readonly label: string;
  readonly timeoutMs: number;
  request(url: string | URL, init?: RequestInit, options?: HttpRequestOptions): Promise<HttpResult>;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULTS = { attempts: 3, baseDelayMs: 500, maxDelayMs: 8_000, maxRetryAfterMs: 60_000 } as const;

const defaultRetryableStatus = (status: number): boolean => status >= 500 && status <= 599;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/** Espera cancelável: o abort limpa o timer (nenhum timer pendente). */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function hasIdempotencyKey(headers: RequestInit['headers']): boolean {
  if (!headers) return false;
  try {
    return new Headers(headers).has('idempotency-key');
  } catch {
    return false;
  }
}

function retryAfterOf(response: Response): number | null {
  const headers = (response as { headers?: { get?: (name: string) => string | null } }).headers;
  return parseRetryAfterMs(typeof headers?.get === 'function' ? headers.get('Retry-After') : null);
}

interface Failure {
  reason: HttpRetryReason;
  retryable: boolean;
  status: number | null;
  retryAfterMs: number | null;
  response?: Response;
  cause?: unknown;
}

/**
 * Cria um cliente com prazo obrigatório. `timeoutMs` ausente, ≤ 0 ou não finito lança na
 * criação (e não compila: o campo é obrigatório no tipo).
 */
export function createHttpClient(options: CreateHttpClientOptions): HttpClient {
  const label = typeof options?.label === 'string' && options.label.trim() ? options.label : 'http-client';
  if (!isPositiveNumber(options?.timeoutMs)) {
    throw new TypeError(
      `createHttpClient(${label}): timeoutMs é obrigatório e deve ser > 0 ` +
        `(timeoutMs is required and must be a positive number)`,
    );
  }
  const timeoutMs = options.timeoutMs;
  const retry = options.retry ?? {};
  const attempts = retry.attempts ?? DEFAULTS.attempts;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError(`createHttpClient(${label}): retry.attempts deve ser inteiro ≥ 1`);
  }
  const baseDelayMs = retry.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = retry.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const maxRetryAfterMs = retry.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs;
  const maxTotalMs = retry.maxTotalMs ?? timeoutMs * attempts + (attempts - 1) * maxDelayMs;
  const jitter = retry.jitter ?? 'full';
  const isRetryableStatus = retry.isRetryableStatus ?? defaultRetryableStatus;
  const retryTransportErrors = retry.retryTransportErrors ?? true;
  const httpErrors = options.httpErrors ?? 'throw';
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  const delayFor = (attempt: number, retryAfterMs: number | null): number => {
    const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
    const backoff = jitter === 'full' ? Math.floor(random() * exp) : exp;
    return Math.min(maxRetryAfterMs, Math.max(backoff, retryAfterMs ?? 0));
  };

  const finalize = (failure: Failure, attempt: number, idempotent: boolean, response?: Response): HttpResult => {
    if (failure.reason === 'timeout') throw new UpstreamTimeoutError(label, timeoutMs, !idempotent, attempt);
    if (failure.reason === 'network') {
      throw new UpstreamUnavailableError({
        label,
        status: null,
        attempts: attempt,
        kind: idempotent ? 'transient' : 'uncertain',
        cause: failure.cause,
      });
    }
    if (httpErrors === 'return' && response) return { response, attempts: attempt };
    if (failure.reason === 'rate_limited') throw new UpstreamRateLimitedError(label, failure.retryAfterMs, attempt);
    throw new UpstreamUnavailableError({
      label,
      status: failure.status,
      attempts: attempt,
      kind: idempotent ? 'transient' : 'uncertain',
    });
  };

  async function request(
    url: string | URL,
    init: RequestInit = {},
    requestOptions: HttpRequestOptions = {},
  ): Promise<HttpResult> {
    const method = (init.method ?? 'GET').toUpperCase();
    const idempotent = requestOptions.idempotent ?? (SAFE_METHODS.has(method) || hasIdempotencyKey(init.headers));
    const signal = init.signal ?? undefined;
    const start = now();

    for (let attempt = 1; ; attempt += 1) {
      if (signal?.aborted) throw abortReason(signal);
      let response: Response | undefined;
      let failure: Failure;
      try {
        response = await fetchWithTimeout(url, init, {
          timeoutMs,
          label,
          uncertain: !idempotent,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
      } catch (err) {
        if (signal?.aborted) throw abortReason(signal);
        const retryable = idempotent && retryTransportErrors;
        failure =
          err instanceof UpstreamTimeoutError
            ? { reason: 'timeout', retryable, status: null, retryAfterMs: null }
            : { reason: 'network', retryable, status: null, retryAfterMs: null, cause: err };
      }

      if (response) {
        const status = response.status;
        if (status < 400) return { response, attempts: attempt };
        if (status === 429) {
          failure = { reason: 'rate_limited', retryable: true, status, retryAfterMs: retryAfterOf(response) };
        } else if (isRetryableStatus(status)) {
          failure = { reason: 'server_error', retryable: idempotent, status, retryAfterMs: null };
        } else {
          if (httpErrors === 'return') return { response, attempts: attempt };
          throw new UpstreamRejectedError({ label, status, attempts: attempt });
        }
      }

      const current = failure!;
      if (current.retryable && attempt < attempts) {
        const delayMs = delayFor(attempt, current.retryAfterMs);
        if (now() - start + delayMs <= maxTotalMs) {
          await options.onRetry?.({
            label,
            attempt,
            delayMs,
            reason: current.reason,
            status: current.status,
            retryAfterMs: current.retryAfterMs,
          });
          await sleep(delayMs, signal);
          if (signal?.aborted) throw abortReason(signal);
          continue;
        }
      }
      return finalize(current, attempt, idempotent, response);
    }
  }

  return { label, timeoutMs, request };
}

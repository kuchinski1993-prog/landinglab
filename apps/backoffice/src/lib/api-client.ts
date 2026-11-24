// Typed wrapper around fetch that always sends the session cookie and redirects
// to /login on 401. Designed for use in client components only (`'use client'`).
// Server components must not import this module: credentials never leave the browser.

import { getActiveStoreId } from './active-store';
import { isCatalogCode } from './errors/describe';
import { isPublicRoute } from './public-routes';
import { loginUrlFor } from './safe-callback-url';

export interface ApiErrorMeta {
  /** Id de correlação vindo do header `X-Correlation-Id` (Story 18.4); o do corpo é lido sozinho. */
  correlationId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Story 18.1b — código estável do erro (`body.code`), quando a API manda. */
  readonly code?: string;
  /** Story 18.1b — `body.details` (ex.: campos inválidos). */
  readonly details?: unknown;
  /** Story 18.1b — id para o suporte: header `X-Correlation-Id` ou `body.correlationId`. */
  readonly correlationId?: string;

  constructor(status: number, message: string, body: unknown, meta: ApiErrorMeta = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    const fields = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    if (typeof fields?.code === 'string' && fields.code) this.code = fields.code;
    if (fields && fields.details !== undefined) this.details = fields.details;
    const correlationId = meta.correlationId || (typeof fields?.correlationId === 'string' ? fields.correlationId : undefined);
    if (correlationId) this.correlationId = correlationId;
  }
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

// All API calls go through the Next.js rewrite (apps/backoffice/next.config.mjs):
// the browser requests `/api/*` against the backoffice's own origin, and Vercel
// proxies it server-side to the Fastify API. This keeps the session cookie
// same-origin from the browser's point of view (set/sent under the backoffice
// domain), which is the only setup the Next middleware can read.
const API_PREFIX = '/api';

function buildUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${API_PREFIX}${suffix}`;
}

// Story 18.4 · código de suporte: um id por requisição, enviado em `X-Correlation-Id` e aceito pela
// API (mesma regra de @blackshop/observability: 8–64 caracteres de [A-Za-z0-9._-]).
const CORRELATION_HEADER = 'X-Correlation-Id';

function newCorrelationId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `bo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Falha de rede (sem resposta): o erro original (TypeError) leva o id enviado. */
function withSentCorrelationId(error: unknown, correlationId: string): unknown {
  if (error instanceof Error && error.name !== 'AbortError') {
    try {
      Object.defineProperty(error, 'correlationId', { value: correlationId, enumerable: false, configurable: true });
    } catch {
      // Erro congelado: segue sem o id.
    }
  }
  return error;
}

function handleUnauthorized(): void {
  // Best-effort redirect — middleware will catch any subsequent navigation too.
  // Story 22.1b (AC13, T11) — nas telas de acesso (lib/public-routes.ts) o 401 é a resposta
  // esperada (senha errada, sem sessão): a tela mostra o erro, sem recarregar. Nas demais, volta ao
  // /login levando o caminho atual (só caminho interno — safeCallbackUrl).
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  if (isPublicRoute(pathname)) return;
  window.location.assign(loginUrlFor(`${pathname}${search ?? ''}`));
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  options: RequestOptions = {}
): Promise<T> {
  const sentCorrelationId = newCorrelationId();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Store-Id': getActiveStoreId(),
    [CORRELATION_HEADER]: sentCorrelationId,
    ...options.headers,
  };

  let serializedBody: BodyInit | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    serializedBody = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path), {
      method,
      headers,
      body: serializedBody,
      credentials: 'include',
      signal: options.signal,
    });
  } catch (error) {
    throw withSentCorrelationId(error, sentCorrelationId);
  }
  // Id devolvido pela API (header; o do corpo é lido pelo ApiError). Sem header (rota fora da API)
  // não usa o id enviado: ele não estaria em log nenhum.
  const correlationId = response.headers?.get?.('x-correlation-id') || undefined;

  if (response.status === 401) {
    handleUnauthorized();
    throw new ApiError(401, 'Unauthorized', null, { correlationId });
  }

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? safeJsonParse(text) : null;

  if (!response.ok) {
    // Último recurso (em inglês) para log. Telas novas exibem o erro via describeError /
    // ErrorBanner e nunca mostram `ApiError.message`; telas legadas que ainda leem `err.message`
    // são migradas na varredura da Story 18.10.
    const message = extractErrorMessage(parsed) ?? `Request failed with status ${response.status}`;
    throw new ApiError(response.status, message, parsed, { correlationId });
  }

  return parsed as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const fields = body as { code?: unknown; message?: unknown; error?: unknown };
  // Story 18.1b — `message` do catálogo @blackshop/errors é PT-BR garantido: preferida a `error`.
  if (typeof fields.code === 'string' && isCatalogCode(fields.code) && typeof fields.message === 'string' && fields.message.trim())
    return fields.message;
  if (typeof fields.error === 'string') return fields.error;
  return null;
}

export const apiClient = {
  get: <T>(path: string, options?: RequestOptions): Promise<T> =>
    request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>('POST', path, body, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>('PUT', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>('PATCH', path, body, options),
  delete: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>('DELETE', path, body, options),
};

export type ApiClient = typeof apiClient;

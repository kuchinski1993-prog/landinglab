// Story 24.4 · cliente da Catalog API da Meta (Graph API) usado pela API (teste de conexão) e pelo
// worker (envio). Três chamadas, nomes da referência oficial
// (developers.facebook.com/docs/marketing-api/reference/product-catalog):
//   - GET  /{catalog_id}?fields=id,name                       → teste de conexão;
//   - POST /{catalog_id}/items_batch                          → item_type=PRODUCT_ITEM, allow_upsert,
//          requests [{ method: UPDATE|DELETE, data }] (até 5000), devolve `handles` e `validation_status`;
//   - GET  /{catalog_id}/check_batch_request_status?handle=…  → status, errors, errors_total_count.
//
// Segurança do token: vai SÓ no header `Authorization: Bearer` — nunca na URL (que pode aparecer em log
// de erro do transporte) nem no corpo. Mensagens de erro nunca levam URL, token nem corpo da requisição;
// a mensagem da Meta passa por `redactMetaMessage` (remove o token e qualquer coisa com cara de token).
//
// Versão: `META_GRAPH_API_VERSION` (default v26.0, a mesma do CAPI da 18.8). Fora de `vNN.0` falha fechado.
// Transporte: `createHttpClient`, UMA tentativa (o retry é do job durável), erros HTTP devolvidos para
// classificar pelo corpo da Meta (o código vem no `error.code`, muitas vezes com HTTP 400).
import { createHttpClient, type HttpClient } from './http/index.js';
import type { MetaItemsBatchRequest } from './meta-catalog-feed.js';

export const META_CATALOG_GRAPH_LABEL = 'meta-catalog';
export const DEFAULT_META_CATALOG_GRAPH_VERSION = 'v26.0';
const VERSION_ENV = 'META_GRAPH_API_VERSION';
const VERSION_FORMAT = /^v\d+\.0$/;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_MESSAGE = 300;

/** Limite de chamadas da Graph/Catalog API (podem vir com HTTP 400). 80009/80014 = catálogo. */
export const META_CATALOG_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613, 80004, 80009, 80014]);
/** Token inválido ou expirado. */
export const META_CATALOG_TOKEN_CODES: ReadonlySet<number> = new Set([102, 190]);

export type MetaCatalogEnv = Record<string, string | undefined>;

/** `META_GRAPH_API_VERSION` fora do formato `vNN.0`. */
export class MetaCatalogVersionError extends Error {
  readonly code = 'META_GRAPH_API_VERSION_INVALID' as const;

  constructor() {
    super(`${VERSION_ENV} inválida: use o formato vNN.0 (ex.: ${DEFAULT_META_CATALOG_GRAPH_VERSION})`);
    this.name = 'MetaCatalogVersionError';
  }
}

export interface MetaCatalogGraphErrorBody {
  code: number | null;
  subcode: number | null;
  isTransient: boolean | null;
  /** Mensagem da Meta já sem token (até 300 caracteres). */
  message: string | null;
}

/** Resposta não-2xx (ou 2xx sem o formato esperado) da Graph API. */
export class MetaCatalogGraphError extends Error {
  readonly code = 'META_CATALOG_HTTP_ERROR' as const;

  constructor(
    readonly status: number,
    readonly graph: MetaCatalogGraphErrorBody,
  ) {
    super(
      `meta-catalog: HTTP ${status}` +
        (graph.code !== null ? ` (erro ${graph.code}${graph.subcode !== null ? `/${graph.subcode}` : ''})` : '') +
        (graph.message ? `: ${graph.message}` : ''),
    );
    this.name = 'MetaCatalogGraphError';
  }
}

export function resolveMetaCatalogGraphVersion(env: MetaCatalogEnv = process.env): string {
  const raw = env[VERSION_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_META_CATALOG_GRAPH_VERSION;
  const value = raw.trim();
  if (!VERSION_FORMAT.test(value)) throw new MetaCatalogVersionError();
  return value;
}

/** Tira o token (literal e qualquer `EAA…`, formato dos tokens da Meta) e corta em 300 caracteres. */
export function redactMetaMessage(message: string, token?: string | null): string {
  let out = message;
  if (token && token.length >= 8) out = out.split(token).join('[token]');
  out = out.replace(/EAA[A-Za-z0-9_-]{10,}/g, '[token]').replace(/access_token=[^&\s]+/gi, 'access_token=[token]');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE - 1)}…` : out;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseMetaCatalogError(body: string, token?: string | null): MetaCatalogGraphErrorBody {
  try {
    const parsed = JSON.parse(body) as { error?: Record<string, unknown> } | null;
    const error = parsed?.error;
    if (!error || typeof error !== 'object') return { code: null, subcode: null, isTransient: null, message: null };
    const rawMessage = typeof error['error_user_msg'] === 'string' ? error['error_user_msg'] : error['message'];
    return {
      code: numberOrNull(error['code']),
      subcode: numberOrNull(error['error_subcode']),
      isTransient: typeof error['is_transient'] === 'boolean' ? error['is_transient'] : null,
      message: typeof rawMessage === 'string' && rawMessage.trim() ? redactMetaMessage(rawMessage, token) : null,
    };
  } catch {
    return { code: null, subcode: null, isTransient: null, message: null };
  }
}

export type MetaCatalogErrorKind = 'transient' | 'token' | 'rejected';

/** Classificação pelo corpo da Meta, não só pelo HTTP (mesma regra da 18.8). */
export function classifyMetaCatalogGraphError(err: MetaCatalogGraphError): MetaCatalogErrorKind {
  const { status, graph } = err;
  if (status === 429 || status >= 500) return 'transient';
  if (graph.isTransient === true || (graph.code !== null && META_CATALOG_RATE_LIMIT_CODES.has(graph.code))) {
    return 'transient';
  }
  if (graph.code !== null && (META_CATALOG_TOKEN_CODES.has(graph.code) || graph.code === 10 || (graph.code >= 200 && graph.code <= 299))) {
    return 'token';
  }
  if (status === 401 || status === 403) return 'token';
  return 'rejected';
}

export interface MetaCatalogInfo {
  id: string;
  name: string;
}

export interface MetaItemValidation {
  retailerId: string;
  errors: string[];
  warnings: string[];
}

export interface MetaItemsBatchResult {
  /** 0 ou 1 handle; vazio = nada foi aceito para processamento. */
  handles: string[];
  validation: MetaItemValidation[];
}

export interface MetaBatchStatus {
  /** `finished` quando a Meta terminou; qualquer outro valor = ainda processando. */
  status: string;
  finished: boolean;
  errorsTotal: number;
  /** Erros por item (o `id` é o retailer_id). */
  errors: Array<{ retailerId: string | null; message: string }>;
}

export interface MetaCatalogGraph {
  getCatalog(catalogId: string, token: string): Promise<MetaCatalogInfo>;
  itemsBatch(catalogId: string, token: string, requests: readonly MetaItemsBatchRequest[]): Promise<MetaItemsBatchResult>;
  batchStatus(catalogId: string, token: string, handle: string): Promise<MetaBatchStatus>;
}

export interface MetaCatalogGraphOptions {
  env?: MetaCatalogEnv;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function messagesOf(value: unknown, token: string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((e) => (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : null))
    .filter((m): m is string => m !== null)
    .map((m) => redactMetaMessage(m, token));
}

export function createMetaCatalogGraph(options: MetaCatalogGraphOptions = {}): MetaCatalogGraph {
  const env = options.env ?? process.env;
  const http: HttpClient = createHttpClient({
    label: META_CATALOG_GRAPH_LABEL,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry: { attempts: 1 },
    httpErrors: 'return',
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const base = (catalogId: string): string =>
    `https://graph.facebook.com/${resolveMetaCatalogGraphVersion(env)}/${encodeURIComponent(catalogId)}`;

  async function call(url: string, token: string, init: RequestInit, idempotent: boolean): Promise<Record<string, unknown>> {
    const { response } = await http.request(
      url,
      { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } },
      { idempotent },
    );
    const body = await response.text();
    if (!response.ok) throw new MetaCatalogGraphError(response.status, parseMetaCatalogError(body, token));
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // cai no erro abaixo
    }
    throw new MetaCatalogGraphError(response.status, { code: null, subcode: null, isTransient: null, message: 'resposta da Meta em formato inesperado' });
  }

  return {
    async getCatalog(catalogId, token) {
      const json = await call(`${base(catalogId)}?fields=id,name`, token, { method: 'GET' }, true);
      return {
        id: typeof json['id'] === 'string' ? json['id'] : catalogId,
        name: typeof json['name'] === 'string' ? json['name'] : '',
      };
    },

    async itemsBatch(catalogId, token, requests) {
      // UPDATE com allow_upsert é idempotente (mesmo retailer_id → mesmo item); DELETE repetido também.
      const json = await call(
        `${base(catalogId)}/items_batch`,
        token,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_type: 'PRODUCT_ITEM', allow_upsert: true, requests }),
        },
        true,
      );
      const handles = Array.isArray(json['handles']) ? json['handles'].filter((h): h is string => typeof h === 'string') : [];
      const validation = Array.isArray(json['validation_status'])
        ? (json['validation_status'] as Array<Record<string, unknown>>).map((v) => ({
            retailerId: typeof v['retailer_id'] === 'string' ? v['retailer_id'] : '',
            errors: messagesOf(v['errors'], token),
            warnings: messagesOf(v['warnings'], token),
          }))
        : [];
      return { handles, validation };
    },

    async batchStatus(catalogId, token, handle) {
      const json = await call(
        `${base(catalogId)}/check_batch_request_status?handle=${encodeURIComponent(handle)}&load_ids_of_invalid_requests=true`,
        token,
        { method: 'GET' },
        true,
      );
      // A Graph devolve `{ data: [ {...} ] }`; aceita também o objeto direto.
      const row = (Array.isArray(json['data']) ? (json['data'][0] as Record<string, unknown> | undefined) : json) ?? {};
      const status = typeof row['status'] === 'string' ? row['status'] : '';
      const errors = Array.isArray(row['errors'])
        ? (row['errors'] as Array<Record<string, unknown>>)
            .filter((e) => typeof e['message'] === 'string')
            .map((e) => ({
              retailerId: typeof e['id'] === 'string' ? e['id'] : null,
              message: redactMetaMessage(e['message'] as string, token),
            }))
        : [];
      const invalidIds = Array.isArray(row['ids_of_invalid_requests'])
        ? (row['ids_of_invalid_requests'] as unknown[]).filter((id): id is string => typeof id === 'string')
        : [];
      for (const id of invalidIds) {
        if (!errors.some((e) => e.retailerId === id)) errors.push({ retailerId: id, message: 'Recusado pela Meta.' });
      }
      return {
        status,
        finished: status.toLowerCase() === 'finished',
        errorsTotal: numberOrNull(row['errors_total_count']) ?? errors.length,
        errors,
      };
    },
  };
}

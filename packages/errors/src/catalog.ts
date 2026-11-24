// Catálogo de erros por módulo, validado em tempo de carga (Story 18.1).
import { AppError } from './app-error.js';

export interface ErrorEntry {
  readonly status: number;
  readonly message: string;
  /** Código de contrato anterior ao padrão `modulo.codigo` (ex.: UPSTREAM_TIMEOUT); nome preservado. */
  readonly legacy?: boolean;
}

export type ErrorEntries = Readonly<Record<string, ErrorEntry>>;

/** Corpo padrão de erro da API. */
export interface ErrorBody<C extends string = string> {
  code: C;
  message: string;
  details?: unknown;
  /** @deprecated alias de `message` para clientes antigos (backoffice lê `error`). */
  error: string;
  /** Só nos códigos legados (`UPSTREAM_*`), como no contrato da story 0.8. */
  statusCode?: number;
  /** Reservado para a story 18.4 (correlation id). */
  correlationId?: string;
}

type CodeOf<E> = Extract<keyof E, string>;

/** Visão não genérica de um catálogo (para quem só consulta: handler, teste de doc). */
export interface AnyCatalog {
  readonly moduleId: string;
  readonly entries: ErrorEntries;
  get(code: string): ErrorEntry | undefined;
}

export interface Catalog<E extends ErrorEntries = ErrorEntries> extends AnyCatalog {
  readonly entries: E;
  has(code: unknown): code is CodeOf<E>;
  get(code: string): ErrorEntry | undefined;
  /** Cria um AppError do código; `message` opcional substitui a do catálogo (deve ser PT-BR). */
  error(code: CodeOf<E>, details?: unknown, message?: string): AppError;
  body(code: CodeOf<E>, details?: unknown, message?: string): ErrorBody<CodeOf<E>>;
}

export interface CatalogOptions<B extends ErrorEntries, K extends CodeOf<B>> {
  /** Prefixo exigido nos códigos próprios. Padrão: `${moduleId}.`; `''` para contratos antigos. */
  prefix?: string;
  /** Catálogo de onde vêm os códigos de `include` (normalmente o comum). */
  base?: Catalog<B>;
  /** Códigos do `base` que este catálogo também responde (mesmo status e mensagem). */
  include?: readonly K[];
  /** Sobrescrita explícita de MENSAGEM de códigos incluídos. Mudar o status lança. */
  overrides?: { readonly [P in K]?: string | ErrorEntry };
}

/** Dono de cada código registrado (detecta colisão entre módulos na carga). */
const registry = new Map<string, string>();

function fail(moduleId: string, reason: string): never {
  throw new Error(`[@blackshop/errors] catálogo '${moduleId}': ${reason}`);
}

function validateEntry(moduleId: string, code: string, entry: ErrorEntry): void {
  if (!code.trim()) fail(moduleId, 'código vazio');
  if (!Number.isInteger(entry?.status) || entry.status < 400 || entry.status > 599)
    fail(moduleId, `status inválido em '${code}' (${String(entry?.status)}); use 400–599`);
  if (typeof entry.message !== 'string' || !entry.message.trim()) fail(moduleId, `mensagem vazia em '${code}'`);
}

export function buildBody<C extends string>(code: C, message: string, details?: unknown, entry?: ErrorEntry): ErrorBody<C> {
  return {
    code,
    message,
    ...(details === undefined ? {} : { details }),
    error: message,
    ...(entry?.legacy ? { statusCode: entry.status } : {}),
  };
}

export function defineCatalog<
  E extends ErrorEntries,
  B extends ErrorEntries = ErrorEntries,
  K extends CodeOf<B> = never,
>(moduleId: string, ownEntries: E, options: CatalogOptions<B, K> = {}): Catalog<E & { readonly [P in K]: ErrorEntry }> {
  if (!moduleId.trim()) fail(moduleId, 'moduleId vazio');
  const prefix = options.prefix ?? `${moduleId}.`;
  const include = options.include ?? [];
  const overrides = (options.overrides ?? {}) as Record<string, string | ErrorEntry | undefined>;
  const base = options.base;
  if (include.length && !base) fail(moduleId, '`include` exige `base`');

  const merged: Record<string, ErrorEntry> = {};
  for (const code of include) {
    const inherited = base?.get(code);
    if (!inherited) fail(moduleId, `código incluído '${code}' não existe no catálogo '${base?.moduleId}'`);
    merged[code] = inherited;
  }
  for (const [code, override] of Object.entries(overrides)) {
    if (override === undefined) continue;
    const inherited = merged[code];
    if (!inherited) fail(moduleId, `sobrescrita de '${code}', que não está em \`include\``);
    const next = typeof override === 'string' ? { ...inherited, message: override } : override;
    if (next.status !== inherited.status)
      fail(moduleId, `sobrescrita de status não permitida em '${code}' (${inherited.status} → ${next.status})`);
    validateEntry(moduleId, code, next);
    merged[code] = { ...inherited, message: next.message };
  }

  for (const [code, entry] of Object.entries(ownEntries)) {
    validateEntry(moduleId, code, entry);
    if (!entry.legacy && prefix && !code.startsWith(prefix))
      fail(moduleId, `código '${code}' fora do padrão; use o prefixo '${prefix}'`);
    const owner = merged[code] ? base?.moduleId : registry.get(code);
    // Redefinir o mesmo módulo (hot reload, resetModules) não é colisão.
    if (owner && owner !== moduleId)
      fail(moduleId, `código '${code}' duplicado entre os módulos '${owner}' e '${moduleId}'`);
    merged[code] = entry;
  }
  for (const code of Object.keys(ownEntries)) registry.set(code, moduleId);

  const entries = Object.freeze(merged) as unknown as E & { readonly [P in K]: ErrorEntry };
  type Code = CodeOf<typeof entries>;
  const get = (code: string): ErrorEntry | undefined => (Object.hasOwn(entries, code) ? merged[code] : undefined);
  return {
    moduleId,
    entries,
    has: (code: unknown): code is Code => typeof code === 'string' && Object.hasOwn(entries, code),
    get,
    error(code: Code, details?: unknown, message?: string) {
      const entry = merged[code] as ErrorEntry;
      return new AppError(message ?? entry.message, entry.status, code, details, { publicMessage: message !== undefined });
    },
    body(code: Code, details?: unknown, message?: string) {
      const entry = merged[code] as ErrorEntry;
      return buildBody(code, message ?? entry.message, details, entry);
    },
  };
}

/** Qual módulo registrou o código (diagnóstico/testes). */
export function catalogOwner(code: string): string | undefined {
  return registry.get(code);
}

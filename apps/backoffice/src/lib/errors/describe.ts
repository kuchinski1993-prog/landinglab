// Story 18.1b — cérebro único "erro → mensagem PT-BR + ação de recuperação".
// Generaliza `describeVslError`: a ação é decidida pelo `code` (tabela de ações) e, sem código
// conhecido, pelo status HTTP. Os renderizadores (components/ds e components/legacy) só desenham.
//
// Ordem da mensagem: (1) tabela da UI por código (módulo pedido → comum → outros módulos);
// (2) `body.message` somente se o código for do catálogo @blackshop/errors (PT-BR garantido);
// (3) genérica por status; (4) `fallback` do chamador. Nunca a `message` crua da exceção.
//
// Não importa `ApiError` de `@/lib/api-client` de propósito: telas testadas com o api-client
// mockado (só `apiClient`) continuam funcionando — o erro é reconhecido pelo formato.

import { COMMON_CATALOG, catalogOwner } from '@blackshop/errors';

import { CODE_ACTIONS, ERROR_LINKS, WAIT_HINT, actionForStatus, type CodeAction, type ErrorAction, type ErrorLinkTarget } from './actions';
import { COMMON_ERROR_MESSAGES, NETWORK_ERROR_MESSAGE, messageForStatus } from './messages/common';
import { findInModules, getModuleMessages, type ErrorMessageEntry } from './register';

export const DEFAULT_FALLBACK_MESSAGE = 'Não foi possível concluir a ação. Tente de novo.';

export interface ErrorInfo {
  /** Código do erro (`network` para falha de rede, `unknown` sem código). */
  code: string;
  /** Status HTTP (0 quando não houve resposta). */
  status: number;
  /** Frase em português pronta para exibir. */
  message: string;
  action: ErrorAction;
  /** Destino da ação `link` (ausente quando a tela não informou o endereço). */
  href?: string;
  /** Rótulo do botão da ação `link`. */
  linkLabel?: string;
  /** O erro pede para esperar antes de tentar de novo (rate limit). */
  wait?: boolean;
  /** `details` do corpo (ex.: campos inválidos em `validation_failed`). */
  details?: unknown;
  /** Id para o suporte (preenchido pela 18.4; aqui só é repassado). */
  correlationId?: string;
}

export interface DescribeErrorOptions {
  /** Mensagens específicas de um módulo registrado (`registerErrorMessages`), ex.: `'vsl'`. */
  module?: string;
  /** Texto quando nada mais se aplica (erro sem status e sem código). */
  fallback?: string;
  /** Endereços para ações `link` que dependem da tela (ex.: `{ checklist: '#checklist' }`). */
  hrefs?: Partial<Record<ErrorLinkTarget, string>>;
}

interface ApiErrorLike extends Error {
  status: number;
  body?: unknown;
  code?: unknown;
  details?: unknown;
  correlationId?: unknown;
}

function isApiErrorLike(error: unknown): error is ApiErrorLike {
  return error instanceof Error && error.name === 'ApiError' && typeof (error as { status?: unknown }).status === 'number';
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === 'TypeError');
}

function objectBody(error: ApiErrorLike): Record<string, unknown> | null {
  return error.body !== null && typeof error.body === 'object' && !Array.isArray(error.body) ? (error.body as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Código do contrato `modulo.codigo` exigido por `defineCatalog` (18.1) — vem de um catálogo da API. */
const MODULE_CODE = /^[a-z][a-z0-9_]*\.[a-z0-9_.]+$/;

/** O código pertence ao catálogo @blackshop/errors (comum ou módulo `modulo.codigo`)? */
export function isCatalogCode(code: string): boolean {
  return COMMON_CATALOG.has(code) || catalogOwner(code) !== undefined || MODULE_CODE.test(code);
}

function lookupUi(code: string, module: string | undefined): ErrorMessageEntry | undefined {
  const own = module ? getModuleMessages(module) : undefined;
  if (own && Object.hasOwn(own, code)) return own[code];
  if (Object.hasOwn(COMMON_ERROR_MESSAGES, code)) return COMMON_ERROR_MESSAGES[code];
  return findInModules(code, module);
}

function withWait(message: string, wait: boolean | undefined): string {
  return wait && !/aguarde/i.test(message) ? `${message} ${WAIT_HINT}` : message;
}

function build(
  base: { code: string; status: number; message: string; details?: unknown; correlationId?: string },
  decided: CodeAction,
  options: DescribeErrorOptions,
): ErrorInfo {
  const info: ErrorInfo = { ...base, message: withWait(base.message, decided.wait), action: decided.action };
  if (decided.wait) info.wait = true;
  if (decided.action === 'link' && decided.link) {
    const link = ERROR_LINKS[decided.link];
    info.linkLabel = link.label;
    const href = options.hrefs?.[decided.link] ?? link.href;
    if (href) info.href = href;
  }
  if (base.details === undefined) delete info.details;
  if (base.correlationId === undefined) delete info.correlationId;
  return info;
}

/** Ação para o código: entrada da tabela de mensagens → tabela de ações por código → status. */
function decideAction(code: string | undefined, entry: ErrorMessageEntry | undefined, status: number): CodeAction {
  if (entry?.action) return { action: entry.action, link: entry.link, wait: entry.wait ?? (code ? CODE_ACTIONS[code]?.wait : undefined) };
  if (code && Object.hasOwn(CODE_ACTIONS, code)) return CODE_ACTIONS[code];
  return actionForStatus(status);
}

/** Converte qualquer erro em mensagem PT-BR com a ação certa. Nunca lança. */
export function describeError(error: unknown, options: DescribeErrorOptions = {}): ErrorInfo {
  const fallback = options.fallback ?? DEFAULT_FALLBACK_MESSAGE;

  if (!isApiErrorLike(error)) {
    if (isNetworkError(error)) {
      // Story 18.4 · o api-client anexa à falha de rede o id que enviou (código para suporte).
      const correlationId = str((error as { correlationId?: unknown }).correlationId);
      return build({ code: 'network', status: 0, message: NETWORK_ERROR_MESSAGE, correlationId }, { action: 'retry' }, options);
    }
    return build({ code: 'unknown', status: 0, message: fallback }, { action: 'none' }, options);
  }

  const body = objectBody(error);
  const status = error.status;
  const explicitCode = str(error.code) ?? str(body?.code);
  const details = error.details !== undefined ? error.details : body?.details;
  const correlationId = str(error.correlationId) ?? str(body?.correlationId);
  const base = { status, details, correlationId };

  if (explicitCode) {
    const entry = lookupUi(explicitCode, options.module);
    if (entry) return build({ ...base, code: explicitCode, message: entry.message }, decideAction(explicitCode, entry, status), options);
    if (isCatalogCode(explicitCode)) {
      const message = str(body?.message) ?? COMMON_CATALOG.get(explicitCode)?.message ?? messageForStatus(status) ?? fallback;
      return build({ ...base, code: explicitCode, message }, decideAction(explicitCode, undefined, status), options);
    }
    // Código fora de qualquer tabela e do catálogo: genérica por status (nunca o texto do corpo).
    return build({ ...base, code: explicitCode, message: messageForStatus(status) ?? fallback }, decideAction(explicitCode, undefined, status), options);
  }

  // Sem código: 401 e 5xx usam as mensagens do módulo (como o VSL sempre fez); o resto, genérica por status.
  const implied = status === 401 ? 'unauthorized' : status >= 500 ? 'internal_error' : undefined;
  const impliedEntry = implied ? lookupUi(implied, options.module) : undefined;
  if (implied && impliedEntry) return build({ ...base, code: implied, message: impliedEntry.message }, decideAction(implied, impliedEntry, status), options);
  return build({ ...base, code: 'unknown', message: messageForStatus(status) ?? fallback }, actionForStatus(status), options);
}

/** Atalho: só a frase em português. */
export function errorMessage(error: unknown, options?: DescribeErrorOptions): string {
  return describeError(error, options).message;
}

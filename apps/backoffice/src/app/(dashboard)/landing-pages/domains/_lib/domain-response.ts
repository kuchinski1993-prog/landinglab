// Story 18.10a (Decisão 3, AC9) — leitor único das respostas das rotas Next de domínios
// (`app/api/domains/**`). Lê o corpo como texto, tenta JSON e devolve `{ ok, status, data }` ou
// lança `ApiError` — assim a tela usa as regras do describeError e nunca mostra
// "Unexpected token '<'…" (502/HTML da Vercel) nem o texto cru do fornecedor no 5xx.
//
// Regras de mensagem (`describeDomainError`):
//   - 401 → describeError (sessão expirada, "Entrar de novo");
//   - 4xx com `message` → o texto curado da rota (português); 409 em uso ganha o "Abra Gerenciar";
//   - 5xx, ou corpo que não é JSON → genérica por status (+ código para suporte); o texto cru vai
//     para `console.warn`;
//   - rede / qualquer outro erro → describeError.

import { ApiError } from '@/lib/api-client';
import { describeError, type ErrorInfo } from '@/lib/errors/describe';

export interface DomainResponse<T> {
  ok: true;
  status: number;
  data: T;
}

const CORRELATION_HEADER = 'x-correlation-id';
const RAW_LOG_LIMIT = 500;
export const IN_USE_HINT = 'Abra "Gerenciar" pra desvincular.';

function parseObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/** Lê a resposta de uma rota de domínio. Sucesso = HTTP 2xx com JSON e `ok !== false`. */
export async function readDomainResponse<T extends object>(res: Response): Promise<DomainResponse<T>> {
  const text = await res.text();
  const data = parseObject(text);
  const correlationId = res.headers.get(CORRELATION_HEADER) ?? undefined;
  if (res.ok && data && data['ok'] !== false) return { ok: true, status: res.status, data: data as T };

  if (!data || res.status >= 500) {
    console.warn(`[domains] resposta ${res.status} não exibida ao usuário:`, text.slice(0, RAW_LOG_LIMIT));
  }
  // Corpo que não é JSON vira `null`: o texto (HTML da Vercel, stack…) nunca chega ao aviso.
  throw new ApiError(res.status, `domain_request_failed_${res.status}`, data, { correlationId });
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function bodyOf(error: ApiError): Record<string, unknown> | null {
  return error.body !== null && typeof error.body === 'object' && !Array.isArray(error.body) ? (error.body as Record<string, unknown>) : null;
}

export function serverUnavailableMessage(status: number): string {
  return `O servidor demorou ou está indisponível (${status}). Tente de novo.`;
}

/** Mensagem + ação para um erro de ação de domínio (formato do `ErrorBanner` → `describe`). */
export function describeDomainError(error: unknown): ErrorInfo {
  if (!(error instanceof ApiError)) return describeError(error);
  const status = error.status;
  if (status === 401) return describeError(error);
  const body = bodyOf(error);
  const base = { status, ...(error.correlationId ? { correlationId: error.correlationId } : {}) };

  if (status >= 500 || !body) {
    const message = status >= 500 ? serverUnavailableMessage(status) : `O servidor respondeu de um jeito inesperado (${status}). Tente de novo.`;
    return { ...base, code: str(body?.['code']) ?? 'unknown', message, action: 'retry' };
  }

  const curated = str(body['message']);
  if (status >= 400 && curated) {
    const inUse = status === 409 && typeof body['bindingsCount'] === 'number' && body['bindingsCount'] > 0;
    return { ...base, code: str(body['code']) ?? 'domain_error', message: inUse ? `${curated} ${IN_USE_HINT}` : curated, action: 'none' };
  }
  return describeError(error);
}

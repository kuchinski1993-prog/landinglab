// Story 0.8 · helper mínimo de HTTP para chamadas a terceiros (Shopify, Meta).
//
// Só o essencial: timeout que cobre cabeçalhos E corpo, leitura de `Retry-After` e erros
// tipados com código estável. Story 18.2: retry/429/orçamento ficam em `client.ts`
// (`createHttpClient`, que usa este helper por tentativa) e o safe-fetch em `safe-fetch.ts`.
//
// Módulo puro, sem import do banco: use pelo subcaminho `@blackshop/shared/http`.
// Mensagens nunca incluem URL, token, corpo de requisição ou de resposta.

import { UpstreamTimeoutError } from './errors.js';

// Story 18.2: as classes de erro moram em `errors.ts`; reexportadas aqui (mesmos nomes da 0.8).
export {
  UpstreamRateLimitedError,
  UpstreamTimeoutError,
  isUpstreamRateLimitedError,
  isUpstreamTimeoutError,
  type UpstreamErrorCode,
} from './errors.js';

/**
 * `Retry-After` em segundos (`"2"`, `"1.5"`) ou data HTTP. Valor inválido ou negativo →
 * `null`; data no passado → `0`.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number = Date.now()): number | null {
  if (header === null || header === undefined) return null;
  const value = header.trim();
  if (value === '') return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  if (/^[-+]?\d/.test(value)) return null; // número negativo/malformado
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

export interface FetchWithTimeoutOptions {
  /** Prazo total (cabeçalhos + corpo). */
  timeoutMs: number;
  /** Nome do serviço para erros e logs (ex.: `shopify-admin`). Nunca a URL. */
  label: string;
  /** A requisição pode ter efeito no terceiro mesmo sem resposta? (default false) */
  uncertain?: boolean;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * `fetch` com prazo que cobre cabeçalhos e corpo. A resposta volta com o corpo já lido
 * (em memória), então `json()`/`text()` do chamador não podem mais travar. O timer é
 * sempre limpo. Timeout → `UpstreamTimeoutError`; outros erros de rede seguem como vieram.
 *
 * Respostas que não são `Response` de verdade (dublês de teste) voltam sem reempacotar.
 */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  options: FetchWithTimeoutOptions,
): Promise<Response> {
  const { timeoutMs, label, uncertain = false } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  // Garante o prazo mesmo se o fetch/corpo ignorar o signal.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  aborted.catch(() => undefined);

  const external = init.signal ?? null;
  const onExternalAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await Promise.race([fetchImpl(input, { ...init, signal: controller.signal }), aborted]);
    if (typeof Response === 'undefined' || !(res instanceof Response)) return res;
    // Corpo já consumido (dublê de teste que reusa a mesma Response): não dá para bufferizar;
    // volta como veio e a leitura do chamador falha como falharia sem o helper.
    if (res.bodyUsed) return res;
    const body = await Promise.race([res.arrayBuffer(), aborted]);
    const empty = body.byteLength === 0;
    return new Response(NULL_BODY_STATUS.has(res.status) || empty ? null : body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (err) {
    if (timedOut) throw new UpstreamTimeoutError(label, timeoutMs, uncertain);
    throw err;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

/** Lê um prazo de variável de ambiente (ms inteiro positivo) ou usa o padrão. */
export function timeoutFromEnv(
  variable: string,
  fallbackMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[variable];
  if (raw === undefined || raw.trim() === '') return fallbackMs;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallbackMs;
}

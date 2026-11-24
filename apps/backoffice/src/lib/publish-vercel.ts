// Story 0.6 — cliente Vercel ÚNICO da publicação de landings + sondagem HTTPS.
//
// Antes existiam duas cópias de `addVercelDomain` (rota publish-on-domain e
// publish-core), ambas sem timeout e tratando `409` como "SSL ok" sem olhar se
// a Vercel tinha mesmo aceitado/verificado o domínio (playbook §13). Aqui:
//   - toda chamada tem timeout (AbortSignal.timeout) — nada fica pendurado;
//   - erro vira `code` estável + `retryable` (nunca "sucesso" silencioso);
//   - 409 é confirmado lendo o domínio NO projeto (se não está lá, o nome
//     pertence a outro projeto → conflito, não sucesso);
//   - o token nunca aparece em log nem em resposta.
//
// Variáveis de ambiente mantidas (não trocar nesta story — ver Fora de escopo):
//   VERCEL_API_TOKEN, VERCEL_TEAM_ID, VERCEL_STOREFRONT_PROJECT_ID.
// O helper compartilhado de timeout/backoff é da story 0.8/18.2; até lá, o
// AbortSignal.timeout direto aqui.

/** Limite por chamada à Vercel. 2 chamadas + sondagem cabem em maxDuration=30. */
export const VERCEL_TIMEOUT_MS = 7_000;
/** Limite por tentativa da sondagem HTTPS do hostname. */
export const HTTPS_PROBE_TIMEOUT_MS = 4_000;
/** Tentativas da sondagem (certificado recém-emitido às vezes falha 1x). */
export const HTTPS_PROBE_ATTEMPTS = 2;
export const HTTPS_PROBE_RETRY_DELAY_MS = 1_000;

const VERCEL_API_BASE = 'https://api.vercel.com';
const DEFAULT_PROJECT_ID = 'landinglab-storefront';

export type VercelErrorCode =
  | 'VERCEL_TIMEOUT'
  | 'VERCEL_UNAVAILABLE'
  | 'VERCEL_TOKEN_MISSING'
  | 'VERCEL_TOKEN_INVALID'
  | 'VERCEL_PROJECT_NOT_ACCESSIBLE'
  | 'VERCEL_DOMAIN_CONFLICT'
  | 'VERCEL_DOMAIN_REJECTED';

/** Registro DNS que a Vercel pede para verificar o domínio (quando `verified: false`). */
export interface VercelVerificationRecord {
  type: string;
  domain: string;
  value: string;
  reason?: string;
}

export type VercelDomainOutcome =
  | {
      ok: true;
      /** A Vercel considera o domínio verificado no projeto. */
      verified: boolean;
      verification: VercelVerificationRecord[];
      /** 409 confirmado: o domínio já estava no projeto (retry idempotente). */
      alreadyInProject: boolean;
    }
  | {
      ok: false;
      code: VercelErrorCode;
      retryable: boolean;
      httpStatus?: number;
      /** Detalhe técnico curto para log (sem token). */
      detail: string;
    };

export interface VercelClientOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

interface VercelConfig {
  token: string | undefined;
  teamId: string | undefined;
  projectId: string;
}

function readConfig(env: Record<string, string | undefined>): VercelConfig {
  const token = env['VERCEL_API_TOKEN']?.trim() || undefined;
  const teamId = env['VERCEL_TEAM_ID']?.trim() || undefined;
  const projectId = env['VERCEL_STOREFRONT_PROJECT_ID']?.trim() || DEFAULT_PROJECT_ID;
  return { token, teamId, projectId };
}

/** `true` quando o token da Vercel está configurado (sem expor o valor). */
export function hasVercelToken(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(readConfig(env).token);
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  );
}

async function readBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function verificationOf(body: Record<string, unknown> | null): VercelVerificationRecord[] {
  const raw = body?.['verification'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
    .map((r) => ({
      type: String(r['type'] ?? ''),
      domain: String(r['domain'] ?? ''),
      value: String(r['value'] ?? ''),
      ...(typeof r['reason'] === 'string' ? { reason: r['reason'] } : {}),
    }));
}

/** Mapeia status HTTP de erro da Vercel → código estável. */
function errorFromStatus(status: number, body: string): VercelDomainOutcome & { ok: false } {
  if (status === 401 || status === 403) {
    return { ok: false, code: 'VERCEL_TOKEN_INVALID', retryable: false, httpStatus: status, detail: body };
  }
  if (status === 404) {
    return {
      ok: false,
      code: 'VERCEL_PROJECT_NOT_ACCESSIBLE',
      retryable: false,
      httpStatus: status,
      detail: body,
    };
  }
  if (status === 429 || status >= 500) {
    return { ok: false, code: 'VERCEL_UNAVAILABLE', retryable: true, httpStatus: status, detail: body };
  }
  return { ok: false, code: 'VERCEL_DOMAIN_REJECTED', retryable: false, httpStatus: status, detail: body };
}

function exceptionOutcome(err: unknown): VercelDomainOutcome & { ok: false } {
  if (isTimeoutError(err)) {
    return { ok: false, code: 'VERCEL_TIMEOUT', retryable: true, detail: 'timeout' };
  }
  const name = err instanceof Error ? err.name : 'unknown_error';
  return { ok: false, code: 'VERCEL_UNAVAILABLE', retryable: true, detail: `network:${name}` };
}

/**
 * Adiciona o hostname ao projeto storefront da Vercel (necessário para emitir
 * o certificado do subdomínio) e devolve se ele está verificado.
 *
 * Idempotente: se a Vercel responder 409, confirma lendo o domínio no projeto
 * (`GET /v9/projects/{id}/domains/{hostname}`); se ele estiver lá, é sucesso.
 */
export async function addVercelDomain(
  hostname: string,
  options: VercelClientOptions = {},
): Promise<VercelDomainOutcome> {
  const config = readConfig(options.env ?? process.env);
  if (!config.token) {
    return {
      ok: false,
      code: 'VERCEL_TOKEN_MISSING',
      retryable: false,
      detail: 'VERCEL_API_TOKEN ausente',
    };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? VERCEL_TIMEOUT_MS;
  const base = options.baseUrl ?? VERCEL_API_BASE;
  const team = config.teamId ? `?teamId=${encodeURIComponent(config.teamId)}` : '';
  const project = encodeURIComponent(config.projectId);
  const headers = {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  };

  let res: Response;
  try {
    res = await fetchImpl(`${base}/v10/projects/${project}/domains${team}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: hostname }),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return exceptionOutcome(err);
  }

  if (res.ok) {
    const body = parseJson(await readBody(res));
    return {
      ok: true,
      verified: body?.['verified'] === true,
      verification: verificationOf(body),
      alreadyInProject: false,
    };
  }

  if (res.status !== 409) {
    return errorFromStatus(res.status, await readBody(res));
  }

  // 409 — já existe. Confirma que está NESTE projeto (e não em outro).
  await readBody(res);
  let check: Response;
  try {
    check = await fetchImpl(
      `${base}/v9/projects/${project}/domains/${encodeURIComponent(hostname)}${team}`,
      {
        method: 'GET',
        headers: { Authorization: headers.Authorization },
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (err) {
    return exceptionOutcome(err);
  }
  if (check.status === 404) {
    return {
      ok: false,
      code: 'VERCEL_DOMAIN_CONFLICT',
      retryable: false,
      httpStatus: 409,
      detail: await readBody(check),
    };
  }
  if (!check.ok) return errorFromStatus(check.status, await readBody(check));
  const body = parseJson(await readBody(check));
  return {
    ok: true,
    verified: body?.['verified'] === true,
    verification: verificationOf(body),
    alreadyInProject: true,
  };
}

export type HttpsProbeOutcome =
  | { ok: true; status: number }
  | { ok: false; reason: 'timeout' | 'tls_or_network'; detail: string };

export interface HttpsProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
}

/**
 * Sonda `https://{hostname}/`. Qualquer resposta HTTP (mesmo 404/405) prova
 * que o handshake TLS passou — o certificado cobre o hostname. Erro de
 * certificado/rede/timeout → não está pronto (o chamador mantém `awaiting_ssl`).
 */
export async function probeHttps(
  hostname: string,
  options: HttpsProbeOptions = {},
): Promise<HttpsProbeOutcome> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? HTTPS_PROBE_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? HTTPS_PROBE_ATTEMPTS);
  const delayMs = options.retryDelayMs ?? HTTPS_PROBE_RETRY_DELAY_MS;
  let last: HttpsProbeOutcome = { ok: false, reason: 'tls_or_network', detail: 'not_attempted' };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await fetchImpl(`https://${hostname}/`, {
        method: 'HEAD',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { ok: true, status: res.status };
    } catch (err) {
      if (isTimeoutError(err)) {
        last = { ok: false, reason: 'timeout', detail: 'timeout' };
      } else {
        const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
        const code = cause && typeof cause.code === 'string' ? cause.code : null;
        last = {
          ok: false,
          reason: 'tls_or_network',
          detail: code ?? (err instanceof Error ? err.name : 'unknown_error'),
        };
      }
    }
  }
  return last;
}

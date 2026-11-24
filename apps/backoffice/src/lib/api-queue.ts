// Enfileira e consulta jobs do worker pela API (Railway), nunca direto no Redis.
//
// Por quê: o Redis fica só na rede interna do Railway, sem acesso público. A Vercel não alcança
// essa rede — conectar daqui dava "Connection is closed.", ECONNRESET ou ENOTFOUND. A API alcança,
// então o backoffice pede para ela, com o cookie de sessão do usuário (mesmo padrão de
// requireVerifiedApiSession). Serve para route handlers e server actions: o cookie vem de cookies().
//
// Falha rápido e com mensagem clara: timeout abaixo do maxDuration das rotas (15 s), para a rota
// sempre responder JSON em vez da página de erro da Vercel.

import { cookies } from 'next/headers';

import { resolveApiBaseUrl } from './session';

// Keep in sync with lib/session.ts, src/middleware.ts e apps/api/src/server.ts.
const SESSION_COOKIE = 'blackshop.sid';
export const API_QUEUE_TIMEOUT_MS = 10_000;

export interface EnqueueOptions {
  jobId?: string;
  attempts?: number;
  backoff?: number | { type: 'fixed' | 'exponential'; delay: number };
  removeOnComplete?: boolean | number | { age?: number; count?: number };
  removeOnFail?: boolean | number | { age?: number; count?: number };
  delay?: number;
  priority?: number;
}

export interface QueueJobStatus {
  jobId: string;
  state: string;
  progress: unknown;
  returnvalue: unknown;
  failedReason: string | null;
  data: Record<string, unknown> | null;
}

/** Cookie de sessão a repassar. Leia no início do request se for usar depois (ex.: dentro de um stream). */
export function sessionHeader(): string {
  const sid = cookies().get(SESSION_COOKIE)?.value;
  if (!sid) throw new Error('Sessão ausente — faça login de novo');
  // Repassa SOMENTE o cookie de sessão.
  return `${SESSION_COOKIE}=${sid}`;
}

async function callApi(path: string, init: RequestInit, cookie?: string): Promise<Response> {
  try {
    return await fetch(`${resolveApiBaseUrl()}${path}`, {
      ...init,
      headers: { ...init.headers, cookie: cookie ?? sessionHeader(), accept: 'application/json' },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(API_QUEUE_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`API não respondeu em ${API_QUEUE_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}

async function errorMessage(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) return 'Sessão expirada — faça login de novo';
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `API respondeu ${res.status}`;
}

const jobsPath = (queue: string) => `/landinglab/queues/${encodeURIComponent(queue)}/jobs`;

/** Enfileira e devolve o id do job. Lança erro com mensagem legível se não conseguir. */
export async function enqueueJob(
  queue: string,
  name: string,
  data: Record<string, unknown>,
  opts: EnqueueOptions = {},
  extra: { dedupeBy?: string } = {},
): Promise<{ jobId: string; deduped: boolean }> {
  const res = await callApi(jobsPath(queue), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data, opts, ...extra }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as { jobId: string; deduped: boolean };
}

/** Enfileira vários jobs numa chamada só. Devolve quantos entraram. */
export async function enqueueBulk(
  queue: string,
  jobs: Array<{ name: string; data: Record<string, unknown>; opts?: EnqueueOptions }>,
): Promise<number> {
  let count = 0;
  // Lotes de até 1000 — a API recusa lotes acima de 2000.
  for (let i = 0; i < jobs.length; i += 1000) {
    const res = await callApi(`${jobsPath(queue)}/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobs: jobs.slice(i, i + 1000) }),
    });
    if (!res.ok) throw new Error(await errorMessage(res));
    count += ((await res.json()) as { count: number }).count;
  }
  return count;
}

/** Estado do job, ou null se ele não existe (removido ou id errado). */
export async function getJobStatus(
  queue: string,
  jobId: string,
  cookie?: string,
): Promise<QueueJobStatus | null> {
  const res = await callApi(`${jobsPath(queue)}/${encodeURIComponent(jobId)}`, { method: 'GET' }, cookie);
  if (res.status === 404) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (body?.error === 'job_not_found') return null;
    // 404 sem job_not_found = rota inexistente (API ainda sem este deploy).
    throw new Error(body?.message ?? 'API respondeu 404');
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as QueueJobStatus;
}

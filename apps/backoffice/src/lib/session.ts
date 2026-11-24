// Page-level auth guard for Server Components.
// Defense-in-depth: the edge middleware (src/middleware.ts) already redirects
// unauthenticated requests, but individual pages call requireSession() so a
// misconfigured matcher or a bypassed middleware still can't leak protected
// data server-side.
//
// The check mirrors middleware.ts: presence of the `blackshop.sid` cookie
// issued by Fastify's @fastify/session (see apps/api/src/server.ts).
//
// Fase 12.A — added requireApiSession for /api/* route handlers.
// Next.js middleware matcher explicitly EXCLUDES /api/*, so route handlers
// must check the cookie themselves. requireApiSession returns a Response 401
// (não redirect — API routes retornam JSON error, não redirect).

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { redirect } from 'next/navigation';

// Keep in sync with src/middleware.ts and apps/api/src/server.ts.
const SESSION_COOKIE = 'blackshop.sid';

/**
 * Redirects to /login (with callbackUrl) when no session cookie is present.
 * Call at the top of any Server Component page that needs auth.
 */
export function requireSession(callbackUrl: string): void {
  const store = cookies();
  if (!store.has(SESSION_COOKIE)) {
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }
}

/**
 * API route handler auth check.
 * Returns null if authenticated; returns 401 Response if not.
 *
 * Uso:
 *   const authError = requireApiSession(req);
 *   if (authError) return authError;
 *   // ... rest of handler ...
 *
 * Segurança:
 * - Lê cookie da REQUEST, não de headers arbitrários.
 * - Cookies são set por Fastify @fastify/session em /api/auth/login com
 *   HttpOnly + Secure + SameSite=Lax → não spoofable de client.
 * - Presença do cookie prova que o browser passou por /login autenticado.
 * - Session lifetime e revocation são gerenciados pelo Fastify session store.
 */
export function requireApiSession(req: Request): NextResponse | null {
  const cookieHeader = req.headers.get('cookie') ?? '';
  const hasSession = parseCookieForName(cookieHeader, SESSION_COOKIE) !== null;
  if (!hasSession) {
    return NextResponse.json(
      { error: 'authentication_required', message: 'No session cookie' },
      { status: 401 },
    );
  }
  return null;
}

// ─── Story 13.10 (hotfix SEC-001) — verificação real da sessão ────────────
//
// requireApiSession só checa a PRESENÇA do cookie — um cookie forjado passa.
// requireVerifiedApiSession pergunta à API Fastify (GET /auth/me, que roda
// fastify.authenticate contra o session store) se a sessão é válida.
//
// Política: FAIL CLOSED. Qualquer resultado que não seja um 200 com
// `{ authenticated: true }` bloqueia a request:
//   - sem cookie            → 401 (sem rede)
//   - API 401/403           → 401
//   - rede/timeout/5xx/outro → 503
// O valor do cookie nunca é logado nem devolvido.

/** Timeout da chamada server-side a /auth/me. */
export const SESSION_VERIFY_TIMEOUT_MS = 3_000;

/**
 * Base da API Fastify — a MESMA usada pelo rewrite `/api/* → ${apiUrl}/*`
 * em next.config.mjs (NEXT_PUBLIC_API_URL, default localhost:3001).
 */
export function resolveApiBaseUrl(): string {
  return (process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001').replace(/\/$/, '');
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: 'authentication_required', message }, { status: 401 });
}

function verificationUnavailable(): NextResponse {
  return NextResponse.json(
    {
      error: 'session_verification_unavailable',
      message: 'Não foi possível validar a sessão agora. Tente novamente em instantes.',
    },
    { status: 503, headers: { 'retry-after': '5' } },
  );
}

/**
 * API route handler auth check com validação REAL da sessão na API.
 * Retorna null se autenticado; senão um Response 401/503 pronto.
 *
 * Uso:
 *   const authError = await requireVerifiedApiSession(req);
 *   if (authError) return authError;
 */
export async function requireVerifiedApiSession(req: Request): Promise<NextResponse | null> {
  const cookieHeader = req.headers.get('cookie') ?? '';
  const sid = parseCookieForName(cookieHeader, SESSION_COOKIE);
  if (sid === null || sid === '') {
    return unauthorized('No session cookie');
  }

  let res: Response;
  try {
    res = await fetch(`${resolveApiBaseUrl()}/auth/me`, {
      method: 'GET',
      // Repassa SOMENTE o cookie de sessão — nada de outros cookies/headers.
      headers: { cookie: `${SESSION_COOKIE}=${sid}`, accept: 'application/json' },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(SESSION_VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    // Sem o cookie no log — só o tipo do erro.
    console.warn(
      '[session] verificação de sessão indisponível:',
      err instanceof Error ? err.name : 'unknown_error',
    );
    return verificationUnavailable();
  }

  if (res.status === 401 || res.status === 403) {
    return unauthorized('Invalid or expired session');
  }
  if (res.status !== 200) {
    console.warn('[session] verificação de sessão: status inesperado da API', res.status);
    return verificationUnavailable();
  }

  try {
    const body = (await res.json()) as { authenticated?: unknown } | null;
    if (body && body.authenticated === true) return null;
  } catch {
    // corpo não-JSON (ex.: rewrite apontando para outro host) → fail closed
  }
  console.warn('[session] verificação de sessão: resposta 200 sem authenticated=true');
  return verificationUnavailable();
}

/**
 * Parse cookie header for a specific cookie name.
 * Returns cookie value (opaque) if present, null otherwise.
 * We don't decode/validate the value — presence is what matters (Fastify
 * validates the session store on its side).
 */
function parseCookieForName(cookieHeader: string, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

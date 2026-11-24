// Auth guard stub para rotas /api/admin/*.
//
// Clerk ainda não está integrado no backoffice (TODO Story 13.3). Até lá,
// admin routes usam guard baseado em header + env whitelist:
//
//   Request header:  x-admin-user-id: <uuid>
//   Env whitelist:   ADMIN_USER_IDS=<comma-separated uuids>
//
// Quando 13.3 landar, este módulo passa a chamar `auth()` do Clerk e
// verifica `sessionClaims.metadata.role === 'admin'`. A assinatura pública
// `assertAdmin(req)` permanece igual — consumidores não precisam mudar.

import { NextResponse } from 'next/server';

import { requireVerifiedApiSession } from '@/lib/session';

export interface AdminIdentity {
  userId: string;
}

export class AdminAuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = 'AdminAuthError';
  }
}

/**
 * Valida que o request vem de um usuário admin autenticado. Lança
 * AdminAuthError com status HTTP correto se falhar. Retorna a identidade
 * admin em caso de sucesso.
 *
 * Segurança: leitura da whitelist é feita em cada chamada (não cacheada) pra
 * permitir revogação sem restart.
 */
export function assertAdmin(req: Request): AdminIdentity {
  const userId = req.headers.get('x-admin-user-id')?.trim();
  if (!userId) {
    throw new AdminAuthError(401, 'Missing x-admin-user-id header');
  }

  const raw = process.env['ADMIN_USER_IDS'];
  if (!raw) {
    throw new AdminAuthError(403, 'Admin whitelist not configured (ADMIN_USER_IDS)');
  }

  const whitelist = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!whitelist.has(userId)) {
    throw new AdminAuthError(403, 'User is not admin');
  }

  return { userId };
}

/**
 * Helper que converte AdminAuthError em NextResponse. Uso:
 *
 *   try { const admin = assertAdmin(req); ... }
 *   catch (err) { return handleAdminAuthError(err); }
 */
export function handleAdminAuthError(err: unknown): NextResponse | null {
  if (err instanceof AdminAuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return null;
}

/**
 * Defense-in-depth gate pra route handlers de escrita.
 * 1. requireVerifiedApiSession — sessão validada na API (identity)
 * 2. assertAdmin       — x-admin-user-id allowlist (authorization)
 *
 * Retorna null se autenticado e autorizado.
 * Retorna Response 401/403 se falhar em qualquer camada.
 *
 * Uso:
 *   const authErr = await requireAdminRequest(req);
 *   if (authErr) return authErr;
 */
export async function requireAdminRequest(req: Request): Promise<NextResponse | null> {
  // Épico 0 · 0.1 — valida a sessão na API (/auth/me). Antes bastava o cookie
  // existir, e qualquer cliente consegue mandar um cookie com esse nome.
  const sessionErr = await requireVerifiedApiSession(req);
  if (sessionErr) return sessionErr;
  try {
    assertAdmin(req);
  } catch (err) {
    const authResponse = handleAdminAuthError(err);
    if (authResponse) return authResponse;
    return NextResponse.json({ error: 'auth_error' }, { status: 500 });
  }
  return null;
}

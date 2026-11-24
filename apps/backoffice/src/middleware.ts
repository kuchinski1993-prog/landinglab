import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { isPublicRoute } from './lib/public-routes';
import { loginUrlFor } from './lib/safe-callback-url';

const SESSION_COOKIE = 'blackshop.sid';

export function middleware(request: NextRequest): NextResponse {
  const hasSession = request.cookies.has(SESSION_COOKIE);
  const isApiRoute = request.nextUrl.pathname.startsWith('/api/');

  if (isApiRoute) {
    // API routes: se sessão presente, injeta x-admin-user-id a partir da
    // whitelist do env (single-admin setup, pré-Clerk Story 13.3).
    // Isso permite que fetch() do browser (sem header manual) passe em
    // requireAdminRequest — o cookie prova identidade, o header injeta autorização.
    // Épico 0 · 0.1 — o header NUNCA vem do cliente: o que o navegador mandar é
    // descartado e só o middleware o injeta. A sessão em si é validada nas
    // rotas (requireVerifiedApiSession / requireAdminRequest → /auth/me).
    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete('x-admin-user-id');
    if (hasSession) {
      const adminIds = process.env['ADMIN_USER_IDS'] ?? '';
      const primaryAdmin = adminIds.split(',').map((s) => s.trim()).filter(Boolean)[0];
      if (primaryAdmin) requestHeaders.set('x-admin-user-id', primaryAdmin);
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Non-API routes: redireciona pra /login quando sem sessão.
  // Story 22.1b (AC12) — as telas de acesso (lib/public-routes.ts) abrem sem sessão (sem loop
  // /login → /login); com sessão também abrem (trocar de conta). As demais, sem cookie, vão para
  // /login?callbackUrl=<caminho interno> (só caminho seguro — safeCallbackUrl).
  const { pathname } = request.nextUrl;
  if (!hasSession && !isPublicRoute(pathname)) {
    const loginUrl = new URL(loginUrlFor(`${pathname}${request.nextUrl.search ?? ''}`), request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Cobre todas as rotas exceto _next internals e favicon.
    // Inclui /api/* explicitamente para injetar header admin.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};

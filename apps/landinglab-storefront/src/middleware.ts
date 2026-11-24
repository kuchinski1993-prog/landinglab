import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Storefront LandingLab middleware — multi-tenant por hostname.
 *
 * Fluxo por request:
 *   1. Extrai hostname do header (fallback pra localhost).
 *   2. Extrai pathname da URL (slug esperado no primeiro segmento).
 *   3. Rewrite pra /landing/<hostname>/<slug> — rota interna que faz o lookup
 *      real via server component (usa Drizzle). Middleware NÃO faz DB query
 *      (edge runtime não suporta postgres-js). Delega pro server component.
 *   4. Skip pra assets internos (_next, favicon) e o próprio /landing/* (evita loop).
 *
 * Notas:
 *   - Middleware roda em Edge Runtime (V8 isolate) — sem acesso a Node APIs
 *     como postgres-js. Por isso o DB lookup vive no server component da
 *     rota /landing/[host]/[[...slug]]/page.tsx.
 *   - Rewrite preserva Host header original — server component lê req.host se
 *     precisar (aqui usamos o param [host] do path pra simplificar).
 */
/**
 * Story 15.4: páginas públicas de pós-venda servidas pelo próprio storefront em
 * qualquer host de landing. Match exato em `/rastreio` (e subpaths) para não
 * capturar slugs de landing que só começam com "rastreio" (ex.: `/rastreio-promo`).
 */
export function isPostSalePath(pathname: string): boolean {
  return (
    pathname === '/rastreio' ||
    pathname.startsWith('/rastreio/') ||
    // Story 15.6: gestão da assinatura (/assinatura e /assinatura/gerir).
    pathname === '/assinatura' ||
    pathname.startsWith('/assinatura/') ||
    pathname === '/policies' ||
    pathname.startsWith('/policies/')
  );
}

export function middleware(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  const pathname = url.pathname;

  // Skip: rotas internas do Next, favicon, arquivos estáticos, rotas API.
  if (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/api/') || // rotas API (ex: /api/t/:slug proxy tracker)
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml' ||
    pathname.startsWith('/landing/') || // já reescrito, evita loop
    pathname.startsWith('/checkout/') || // Story 15.3: checkout Stripe (páginas React)
    isPostSalePath(pathname) // Story 15.4: /rastreio e /policies/* (páginas React)
  ) {
    return NextResponse.next();
  }

  // Story 15.3: arquivo de verificação do Apple Pay em qualquer domínio de landing.
  if (pathname === '/.well-known/apple-developer-merchantid-domain-association') {
    const rewrite = request.nextUrl.clone();
    rewrite.pathname = '/api/apple-pay-domain';
    return NextResponse.rewrite(rewrite);
  }

  // Extrai hostname (Vercel usa 'x-forwarded-host', local usa 'host').
  const host =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    'localhost';

  // Normaliza hostname (remove porta + www).
  const hostname = host
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');

  // Extrai slug (primeiro segmento do path, sem barras). Vazio = root.
  // Ex: '/oferta1' → 'oferta1'; '/' → ''
  // Suporta subpaths só de 1 nível por enquanto (dominio.com/oferta1).
  // Multi-nível vira o slug inteiro (dominio.com/a/b → 'a/b').
  const slug = pathname === '/' ? '' : pathname.replace(/^\/+/, '');

  // Rewrite pra rota interna que faz DB lookup.
  // /landing/<hostname>/<slug?>
  url.pathname = slug
    ? `/landing/${encodeURIComponent(hostname)}/${slug}`
    : `/landing/${encodeURIComponent(hostname)}`;

  return NextResponse.rewrite(url);
}

// Roda em tudo exceto assets internos do Next + favicon + rotas API.
export const config = {
  matcher: ['/((?!_next/static|_next/image|api/|favicon.ico|robots.txt|sitemap.xml).*)'],
};

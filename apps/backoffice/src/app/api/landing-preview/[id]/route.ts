// GET /api/landing-preview/[id]
//
// Preview público da landing (sem auth) — funciona SEM DNS/SSL configurado.
// Serve o html_body direto do banco, com Content-Security-Policy relaxada
// pra permitir que os assets do Supabase Storage carreguem.
//
// Uso: enquanto o dono ainda não comprou domínio próprio, essa URL permite
// testar layout, botões, tracking, etc. Uma vez publicada com domínio real,
// esta URL continua funcionando como fallback.

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { EMPTY_THUMBNAIL_HTML, THUMBNAIL_CSP, thumbnailHtml } from '@/lib/landing-preview-thumb';
import { requireVerifiedApiSession } from '@/lib/session';
const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

export async function GET(req: Request, { params }: RouteContext): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const { id } = params;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json(
      { ok: false, message: 'ID inválido' },
      { status: 400 },
    );
  }

  const db = getDb();
  const [row] = await db
    .select({
      htmlBody: landingPages.htmlBody,
      title: landingPages.title,
      slug: landingPages.slug,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, id), eq(landingPages.storeId, STORE_ID)))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { ok: false, message: 'Landing não encontrada' },
      { status: 404 },
    );
  }

  // Story 20.10a (retrabalho) — `?thumb=1`: miniatura do cartão da lista de landings. Sem scripts,
  // noscript (pixels), frames nem pré-carregamentos e com CSP fechada; o cartão abre num iframe
  // `sandbox=""`. Cache curto e privado: rolar a lista para cima e para baixo não baixa de novo.
  if (new URL(req.url).searchParams.get('thumb') === '1') {
    const body = row.htmlBody?.trim() ? thumbnailHtml(row.htmlBody) : EMPTY_THUMBNAIL_HTML;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, max-age=300',
        'content-security-policy': THUMBNAIL_CSP,
        'x-frame-options': 'SAMEORIGIN',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  }

  const html = row.htmlBody ?? '<h1>Landing sem HTML</h1>';

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Sem cache — preview reflete edições imediatamente.
      'cache-control': 'no-store, must-revalidate',
      // Permite carregar assets Supabase + qualquer CDN (landing é 3rd-party)
      'content-security-policy':
        "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
        "img-src * data: blob:; style-src * 'unsafe-inline'; " +
        "script-src * 'unsafe-inline' 'unsafe-eval'; " +
        "font-src * data:; " +
        "connect-src *;",
      // Deixa iframeable pro preview no backoffice
      'x-frame-options': 'ALLOWALL',
    },
  });
}

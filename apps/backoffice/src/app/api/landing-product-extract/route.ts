// GET /api/landing-product-extract?landingId=UUID
// Roda extractProductFromHtml no HTML da landing e retorna estrutura sugerida
// pra criar produto Shopify. Zero custo AI.

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { requireVerifiedApiSession } from '@/lib/session';
const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const landingId = url.searchParams.get('landingId');
  if (!landingId) {
    return NextResponse.json({ ok: false, message: 'landingId obrigatório' }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      htmlBody: landingPages.htmlBody,
      sourceUrl: landingPages.sourceUrl,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }
  if (!row.htmlBody || row.htmlBody.length < 50) {
    return NextResponse.json({ ok: false, message: 'Landing sem HTML' }, { status: 400 });
  }

  // webpackIgnore preserva import() dinâmico em runtime (evita Next.js
  // transformar em require() que crasha com ERR_REQUIRE_ESM no cloner ESM).
  const mod = (await import(/* webpackIgnore: true */ '@blackshop/landinglab-cloner')) as {
    extractProductFromHtml: (
      html: string,
      opts?: { sourceUrl?: string },
    ) => unknown;
  };
  const extracted = mod.extractProductFromHtml(row.htmlBody, {
    sourceUrl: row.sourceUrl ?? undefined,
  });

  return NextResponse.json({ ok: true, extracted });
}

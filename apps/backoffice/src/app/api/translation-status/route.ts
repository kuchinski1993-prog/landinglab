// GET /api/translation-status?landingId=UUID
//
// Endpoint minimal de polling da UI durante tradução automática (Fase T).
// Retorna apenas os campos que a barra de progresso precisa — evita puxar
// html_body inteiro (que pode ter 100KB+) a cada 2s.
//
// Se translation_status ∈ (text_pending, text_running, images_pending,
// images_running) o cliente continua polling. Ao virar done / done_with_warnings
// / failed, para.

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { requireVerifiedApiSession } from '@/lib/session';
const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 5;
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const landingId = url.searchParams.get('landingId')?.trim();

  if (!landingId) {
    return NextResponse.json({ ok: false, message: 'landingId obrigatório' }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: landingPages.id,
      translationStatus: landingPages.translationStatus,
      translationProgress: landingPages.translationProgress,
      targetLanguage: landingPages.targetLanguage,
      initialTargetLanguage: landingPages.initialTargetLanguage,
      initialTranslateImages: landingPages.initialTranslateImages,
      updatedAt: landingPages.updatedAt,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }

  const status = row.translationStatus ?? 'idle';
  const isActive =
    status === 'text_pending' ||
    status === 'text_running' ||
    status === 'images_pending' ||
    status === 'images_running';

  return NextResponse.json({
    ok: true,
    landingId: row.id,
    translationStatus: status,
    translationProgress: row.translationProgress ?? {},
    targetLanguage: row.targetLanguage,
    initialTargetLanguage: row.initialTargetLanguage,
    initialTranslateImages: row.initialTranslateImages,
    updatedAt: row.updatedAt,
    // Convenience flag pro cliente saber se continua polling
    isActive,
  });
}

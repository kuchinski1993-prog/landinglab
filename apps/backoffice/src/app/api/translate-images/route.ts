// POST /api/translate-images (Fase S.2 — set/2026)
//
// Antes: tradução de imagens só existia via SSE em /translate-images/stream/,
// que só funciona em dev local (filesystem public/cloned). Em prod Vercel
// (read-only FS) e worker Railway (assets no Supabase Storage) o SSE falhava.
//
// Agora: endpoint proxy que só enfileira job em queue 'landinglab.translate-images'
// (worker Railway consome usando storage adapter Supabase). Retorna 200
// imediato com { jobId }. UI polleia landing_pages.translation_status +
// translation_progress a cada 2s.
//
// O endpoint /stream/ antigo continua existindo pra dev local (não removido
// pra não quebrar quem testa localmente com public/cloned).
//
// Worker processor:
//   apps/worker/src/processors/landinglab-translate-images.processor.ts

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { and, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { enqueueJob } from '@/lib/api-queue';
import { getDb } from '@/lib/landing-db';
import { buildRateLimitResponse, getClientIdentity, rateLimit } from '@/lib/rate-limit';
import { requireVerifiedApiSession } from '@/lib/session';
const STORE_ID = 'l0i';
const TRANSLATE_IMAGES_QUEUE = 'landinglab.translate-images';

export const runtime = 'nodejs';
export const maxDuration = 15; // só enfileira

const ALLOWED_LANGS = ['en', 'it', 'de', 'fr', 'es', 'ja', 'zh', 'pt-BR', 'pt'] as const;
type AllowedLang = (typeof ALLOWED_LANGS)[number];

interface TranslateImagesRequestBody {
  landingId?: string;
  targetLanguage?: string;
  sourceLanguage?: string;
  brandFrom?: string | null;
  brandTo?: string | null;
  targetDemographic?: string | null;
  minWords?: number;
  minConfidence?: number;
  /**
   * Whitelist explícita de URLs pra traduzir. Se fornecida, processor
   * filtra mediaUrls pra só rodar Seedream nas URLs listadas.
   * Se undefined/null/vazia, processor traduz TODAS as imagens Supabase
   * (comportamento legacy).
   */
  selectedUrls?: string[];
}

export async function POST(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  try {
    return await handlePost(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[translate-images] uncaught error:', message);
    return NextResponse.json(
      { ok: false, message: `Erro interno: ${message}` },
      { status: 500 },
    );
  }
}

async function handlePost(req: Request): Promise<Response> {
  const rl = await rateLimit(`translate-images:${getClientIdentity(req)}`, 100, 60 * 60 * 1000);
  if (!rl.ok) return buildRateLimitResponse(rl.resetAt);

  let body: TranslateImagesRequestBody;
  try {
    body = (await req.json()) as TranslateImagesRequestBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  const { landingId } = body;
  const sourceLanguage = body.sourceLanguage ?? 'auto';

  if (!landingId) {
    return NextResponse.json({ ok: false, message: 'landingId obrigatório' }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: landingPages.id,
      mediaUrls: landingPages.mediaUrls,
      targetLanguage: landingPages.targetLanguage,
      brandFrom: landingPages.brandFrom,
      brandTo: landingPages.brandTo,
      targetDemographic: landingPages.targetDemographic,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }

  // Se selectedUrls veio (whitelist explícita do Step 2), usa esse count.
  // Senão fallback pro count total de mediaUrls.
  const hasWhitelist =
    Array.isArray(body.selectedUrls) && body.selectedUrls.length > 0;
  const imagesCount = hasWhitelist
    ? body.selectedUrls!.length
    : (row.mediaUrls ?? []).filter((u): u is string => typeof u === 'string').length;
  if (imagesCount === 0) {
    return NextResponse.json(
      { ok: false, message: 'Nenhuma imagem selecionada pra traduzir' },
      { status: 400 },
    );
  }

  const targetLanguage = body.targetLanguage ?? row.targetLanguage ?? null;
  if (!targetLanguage || !ALLOWED_LANGS.includes(targetLanguage as AllowedLang)) {
    return NextResponse.json(
      {
        ok: false,
        message: `targetLanguage obrigatório. Aceitos: ${ALLOWED_LANGS.join(', ')}`,
      },
      { status: 400 },
    );
  }

  // Marca status como images_pending ANTES de enfileirar — UI já mostra
  // "aguardando worker" enquanto BullMQ pega o job.
  await db
    .update(landingPages)
    .set({
      translationStatus: 'images_pending',
      translationProgress: sql`jsonb_build_object(
        'phase', 'queued',
        'imagesTotal', ${imagesCount}::int,
        'imagesDone', 0,
        'imagesFailed', 0,
        'imagesSkipped', 0,
        'lastUpdatedAt', ${new Date().toISOString()}::text
      )`,
      updatedAt: new Date(),
    })
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)));

  let jobId: string;
  try {
    // Sanitiza selectedUrls: só string arrays não vazios viram whitelist
    const selectedUrls =
      Array.isArray(body.selectedUrls) && body.selectedUrls.length > 0
        ? body.selectedUrls.filter((u): u is string => typeof u === 'string' && u.length > 0)
        : null;

    ({ jobId } = await enqueueJob(
      TRANSLATE_IMAGES_QUEUE,
      'TranslateImagesJob',
      {
        landingPageId: landingId,
        targetLanguage,
        sourceLanguage,
        brandFrom: body.brandFrom ?? row.brandFrom ?? null,
        brandTo: body.brandTo ?? row.brandTo ?? null,
        targetDemographic: body.targetDemographic ?? row.targetDemographic ?? null,
        minWords: body.minWords,
        minConfidence: body.minConfidence,
        selectedUrls,
      },
      {
        jobId: `translate-images-${landingId}-${Date.now()}`,
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 },
      },
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Reverte status pro estado anterior pra UI não ficar travada em pending
    await db
      .update(landingPages)
      .set({
        translationStatus: 'failed',
        translationProgress: sql`jsonb_build_object(
          'phase', 'error',
          'message', ${`Falha ao enfileirar: ${message}`.slice(0, 500)}::text,
          'lastUpdatedAt', ${new Date().toISOString()}::text
        )`,
        updatedAt: new Date(),
      })
      .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)));

    return NextResponse.json(
      { ok: false, message: `Falha ao enfileirar tradução de imagens: ${message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    landingId,
    jobId,
    status: 'queued',
    imagesCount,
    targetLanguage,
    message: `Tradução de ${imagesCount} imagem(ns) enfileirada — polleie translation_status.`,
  });
}

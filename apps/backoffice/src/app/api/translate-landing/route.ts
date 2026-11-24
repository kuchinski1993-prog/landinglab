// POST /api/translate-landing (Fase S.1 — REESCRITO 2026-09-16)
//
// Antes: rodava translateHtml() sync no Vercel. Falhava por timeout Function
// (Vercel Free tier = 10s hard limit, Haiku demora 30-60s).
//
// Agora: enfileira job em queue 'landinglab.translate-text' (worker Railway
// consome). Retorna 200 imediato com { jobId }. Frontend polleia a landing
// pra ver quando updated_at mudou (indicador simples).
//
// Body:
//   { landingId, targetLanguage?, sourceLanguage?, brandFrom?, brandTo? }
//   - targetLanguage: se omitido, lê de landing_pages.target_language
//   - brandFrom/brandTo: se omitidos, lê de landing_pages.brand_from/to
//
// Worker processor:
//   apps/worker/src/processors/landinglab-translate-text.processor.ts

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { enqueueJob } from '@/lib/api-queue';
import { getDb } from '@/lib/landing-db';
import { buildRateLimitResponse, getClientIdentity, rateLimit } from '@/lib/rate-limit';
import { requireVerifiedApiSession } from '@/lib/session';
const STORE_ID = 'l0i';
const TRANSLATE_QUEUE = 'landinglab.translate-text';

export const runtime = 'nodejs';
export const maxDuration = 15; // agora só enfileira

const ALLOWED_LANGS = ['en', 'it', 'de', 'fr', 'es', 'ja', 'zh', 'pt-BR', 'pt'] as const;
type AllowedLang = (typeof ALLOWED_LANGS)[number];

interface TranslateRequestBody {
  landingId?: string;
  targetLanguage?: string;
  sourceLanguage?: string;
  brandFrom?: string | null;
  brandTo?: string | null;
}

export async function POST(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  try {
    return await handleTranslatePost(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[translate-landing] uncaught error:', message);
    return NextResponse.json(
      { ok: false, message: `Erro interno: ${message}` },
      { status: 500 },
    );
  }
}

async function handleTranslatePost(req: Request): Promise<Response> {
  // Rate limit: 100/hora por session/IP (aumentado — dono pode retentar sem stress)
  const rl = await rateLimit(`translate-landing:${getClientIdentity(req)}`, 100, 60 * 60 * 1000);
  if (!rl.ok) return buildRateLimitResponse(rl.resetAt);

  let body: TranslateRequestBody;
  try {
    body = (await req.json()) as TranslateRequestBody;
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
      htmlBody: landingPages.htmlBody,
      targetLanguage: landingPages.targetLanguage,
      brandFrom: landingPages.brandFrom,
      brandTo: landingPages.brandTo,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }
  if (!row.htmlBody || row.htmlBody.length < 50) {
    return NextResponse.json(
      { ok: false, message: 'Landing sem HTML — nada pra traduzir' },
      { status: 400 },
    );
  }

  // Resolve target language: body override > row.targetLanguage
  const targetLanguage = body.targetLanguage ?? row.targetLanguage ?? null;
  if (!targetLanguage || !ALLOWED_LANGS.includes(targetLanguage as AllowedLang)) {
    return NextResponse.json(
      {
        ok: false,
        message: `targetLanguage obrigatório. Configure no Wizard ou passe no body. Aceitos: ${ALLOWED_LANGS.join(', ')}`,
      },
      { status: 400 },
    );
  }

  // Enfileira job pro worker Railway processar
  let jobId: string;
  try {
    ({ jobId } = await enqueueJob(
      TRANSLATE_QUEUE,
      'TranslateTextJob',
      {
        landingPageId: landingId,
        targetLanguage,
        sourceLanguage,
        brandFrom: body.brandFrom ?? row.brandFrom ?? null,
        brandTo: body.brandTo ?? row.brandTo ?? null,
      },
      {
        jobId: `translate-text-${landingId}-${Date.now()}`,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 },
      },
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, message: `Falha ao enfileirar tradução: ${message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    landingId,
    jobId,
    status: 'queued',
    targetLanguage,
    message:
      'Tradução enfileirada — o worker vai processar em ~30-60 segundos. ' +
      'Recarregue a página pra ver o resultado.',
  });
}

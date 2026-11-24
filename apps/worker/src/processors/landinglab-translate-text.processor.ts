// LandingLab · translate-text processor (Fase S.1 + T — set/2026)
//
// Consumes queue 'landinglab.translate-text':
//   1. Recebe { landingPageId, targetLanguage, sourceLanguage?, brandFrom?, brandTo? }
//   2. Marca translation_status='text_running'
//   3. Query landing_pages pra pegar html_body + brand_from/to
//   4. Chama translateHtml() (Anthropic Haiku)
//   5. UPDATE landing_pages.html_body + target_language + translation_progress
//   6. Se landing.initial_translate_images = true → enfileira translate-images
//      e marca translation_status='images_pending'
//   7. Caso contrário → marca translation_status='done'
//
// Motivo (vs endpoint Vercel direto): Vercel Free tier mata Function em 10s.
// Haiku tradução demora 30-60s → cliente vê "Unexpected end of JSON input".
// Worker Railway não tem limite de duração.
//
// Custo: ~$0.03/landing (Anthropic Haiku, ~10K tokens médios).

import { createClient, landingPages } from '@blackshop/db';
import { translateHtml } from '@blackshop/landinglab-cloner';
import { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { logger } from '../logger.js';

import type { Job } from 'bullmq';

const STORE_ID = 'l0i';
const TRANSLATE_IMAGES_QUEUE = 'landinglab.translate-images';

export interface LandingLabTranslateTextJobData {
  landingPageId: string;
  targetLanguage: string;
  sourceLanguage?: string;
  /** Override — se omitido, lê do landing_pages.brand_from/to */
  brandFrom?: string | null;
  brandTo?: string | null;
}

// Redis singleton pra enfileirar chain step (translate-images) sem reconnect.
let cachedImagesQueue: Queue | null = null;
function getImagesQueue(): Queue | null {
  if (cachedImagesQueue) return cachedImagesQueue;
  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) return null;
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  cachedImagesQueue = new Queue(TRANSLATE_IMAGES_QUEUE, { connection });
  return cachedImagesQueue;
}

export async function processLandingLabTranslateText(
  job: Job<LandingLabTranslateTextJobData>,
): Promise<{
  ok: true;
  stringsTranslated: number;
  costUsd: number;
  latencyMs: number;
  chainedImages: boolean;
}> {
  const { landingPageId, targetLanguage } = job.data;
  const sourceLanguage = job.data.sourceLanguage ?? 'auto';
  const startedAt = Date.now();

  logger.info(
    { jobId: job.id, landingPageId, targetLanguage },
    'landinglab.translate-text: started',
  );

  const { db, sql: sqlEnd } = createClient({
    databaseUrl:
      process.env['DATABASE_URL'] ??
      'postgresql://blackshop:changeme@localhost:5432/blackshop',
  });

  try {
    // 1. Pega html + brand fields + flag de imagens
    const [row] = await db
      .select({
        htmlBody: landingPages.htmlBody,
        brandFrom: landingPages.brandFrom,
        brandTo: landingPages.brandTo,
        initialTranslateImages: landingPages.initialTranslateImages,
      })
      .from(landingPages)
      .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)))
      .limit(1);

    if (!row) {
      throw new Error(`Landing ${landingPageId} não encontrada`);
    }
    if (!row.htmlBody || row.htmlBody.length < 50) {
      throw new Error('Landing sem HTML — nada pra traduzir');
    }

    // 2. Marca status text_running + zera progresso
    await db
      .update(landingPages)
      .set({
        translationStatus: 'text_running',
        translationProgress: sql`jsonb_build_object(
          'phase', 'text:translating',
          'stringsTranslated', 0,
          'costUsd', 0,
          'lastUpdatedAt', ${new Date().toISOString()}::text
        )`,
        updatedAt: new Date(),
      })
      .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)));

    const brandFrom = job.data.brandFrom ?? (row.brandFrom as string | null) ?? null;
    const brandTo = job.data.brandTo ?? (row.brandTo as string | null) ?? null;

    // 3. Traduz — com callback pra emitir progresso incremental no DB.
    //
    // Throttle: DB update é caro. Só atualiza se:
    //   - Passou >= 3s desde último update, OU
    //   - É o primeiro batch (pra fixar totalStrings ASAP na UI)
    // Sem throttle, 16 batches sequenciais → 16 UPDATEs em 5min. Com throttle,
    // ~10 UPDATEs esperados.
    let lastProgressUpdate = 0;
    const result = await translateHtml({
      html: row.htmlBody,
      sourceLanguage,
      targetLanguage,
      brandFrom,
      brandTo,
      onBatchProgress: async (evt) => {
        const now = Date.now();
        const isFirst = evt.batchIndex === 1;
        if (!isFirst && now - lastProgressUpdate < 3000) return;
        lastProgressUpdate = now;
        try {
          await db
            .update(landingPages)
            .set({
              translationProgress: sql`translation_progress || jsonb_build_object(
                'stringsTranslated', ${evt.stringsTranslated}::int,
                'totalStrings', ${evt.totalStrings}::int,
                'batchIndex', ${evt.batchIndex}::int,
                'totalBatches', ${evt.totalBatches}::int,
                'lastUpdatedAt', ${new Date().toISOString()}::text
              )`,
              updatedAt: new Date(),
            })
            .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)));
        } catch {
          // silêncio — falha em progress update NUNCA aborta tradução
        }
      },
    });

    // 4. Decide próximo estado: se initialTranslateImages, encadeia; senão termina.
    const shouldChainImages = row.initialTranslateImages === true;
    const nextStatus: 'done' | 'images_pending' = shouldChainImages ? 'images_pending' : 'done';

    // 5. Salva resultado + próximo status atomicamente
    await db
      .update(landingPages)
      .set({
        htmlBody: result.html,
        targetLanguage: targetLanguage as 'de' | 'it' | 'en' | 'es' | 'fr',
        translationStatus: nextStatus,
        translationProgress: sql`jsonb_build_object(
          'phase', ${shouldChainImages ? 'text:done_awaiting_images' : 'complete'}::text,
          'stringsTranslated', ${result.stats.stringsTranslated}::int,
          'totalStrings', ${result.stats.stringsExtracted}::int,
          'costUsd', ${result.stats.totalCostUsd}::numeric,
          'lastUpdatedAt', ${new Date().toISOString()}::text
        )`,
        updatedAt: new Date(),
      })
      .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)));

    // 6. Enfileira chain step se pediu imagens
    let chainedImages = false;
    if (shouldChainImages) {
      const queue = getImagesQueue();
      if (queue) {
        try {
          await queue.add(
            'TranslateImagesJob',
            {
              landingPageId,
              targetLanguage,
              sourceLanguage,
              brandFrom,
              brandTo,
            },
            {
              jobId: `translate-images-${landingPageId}-${Date.now()}`,
              attempts: 2,
              backoff: { type: 'exponential', delay: 10_000 },
              removeOnComplete: { age: 3600, count: 100 },
              removeOnFail: { age: 86400 },
            },
          );
          chainedImages = true;
        } catch (err) {
          logger.warn(
            { jobId: job.id, landingPageId, err },
            'landinglab.translate-text: falha ao enfileirar translate-images (não-fatal — texto foi traduzido)',
          );
          // Não bloqueia — texto já foi salvo. Marca warning.
          await db
            .update(landingPages)
            .set({
              translationStatus: 'done_with_warnings',
              translationProgress: sql`translation_progress || jsonb_build_object(
                'warnings', 'Texto traduzido mas falhou ao enfileirar tradução de imagens',
                'lastUpdatedAt', ${new Date().toISOString()}::text
              )`,
            })
            .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)))
            .catch(() => {});
        }
      }
    }

    const latencyMs = Date.now() - startedAt;
    logger.info(
      {
        jobId: job.id,
        landingPageId,
        stringsTranslated: result.stats.stringsTranslated,
        costUsd: result.stats.totalCostUsd,
        latencyMs,
        errors: result.errors,
        chainedImages,
      },
      'landinglab.translate-text: completed',
    );

    return {
      ok: true,
      stringsTranslated: result.stats.stringsTranslated,
      costUsd: result.stats.totalCostUsd,
      latencyMs,
      chainedImages,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { jobId: job.id, landingPageId, err, message },
      'landinglab.translate-text: failed',
    );
    // Marca failed no DB (não deixa em text_running órfão)
    await db
      .update(landingPages)
      .set({
        translationStatus: 'failed',
        translationProgress: sql`jsonb_build_object(
          'phase', 'error',
          'message', ${message.slice(0, 500)}::text,
          'lastUpdatedAt', ${new Date().toISOString()}::text
        )`,
        updatedAt: new Date(),
      })
      .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)))
      .catch(() => {});
    throw err;
  } finally {
    await sqlEnd.end();
  }
}

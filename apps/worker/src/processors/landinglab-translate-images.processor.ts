// LandingLab · translate-images processor (Fase S.2 — set/2026)
//
// Consumes queue 'landinglab.translate-images':
//   1. Recebe { landingPageId, targetLanguage, sourceLanguage?, minWords?, minConfidence? }
//   2. Query landing_pages pra pegar mediaUrls + brand_from/to
//   3. Roda translateImages() do @blackshop/landinglab-cloner com adapter Supabase
//   4. Emite progresso ao vivo em landing_pages.translation_progress (jsonb)
//   5. Ao final:
//        - se failed == 0 → translation_status = 'done'
//        - se failed > 0  → translation_status = 'done_with_warnings' (falha parcial)
//
// Storage adapter: baixa do bucket 'cloned-landings' via publicUrl → Buffer,
// e sobre de volta com upsert. As URLs de imagens em landing_pages.media_urls
// já são URLs públicas do Supabase (feitas pelo clone processor), então o
// adapter parseia o path do URL e trabalha em cima disso.
//
// Custo: ~$0.15/imagem (OCR + Gemini + Seedream). Landing típica com 5-15
// imagens embutidas → $0.75-$2.25 por landing.

import { createClient, landingPages } from '@blackshop/db';
import { translateImages, type StorageAdapter } from '@blackshop/landinglab-cloner';
import type { Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';

import { logger } from '../logger.js';
import { getSupabaseAdmin } from '../supabase.js';

const STORE_ID = 'l0i';
const CLONE_BUCKET = 'cloned-landings';

export interface LandingLabTranslateImagesJobData {
  landingPageId: string;
  targetLanguage: string;
  sourceLanguage?: string;
  /** Override — se omitido, lê do landing_pages.brand_from/to */
  brandFrom?: string | null;
  brandTo?: string | null;
  /** Fase R — override de demografia; se omitido, lê de landing_pages.target_demographic */
  targetDemographic?: string | null;
  /** Thresholds OCR — defaults 3 / 40. */
  minWords?: number;
  minConfidence?: number;
  /**
   * Whitelist explícita de URLs pra traduzir. Se presente, o processor
   * filtra mediaUrls pra só rodar Seedream nessas. Se null/undefined,
   * traduz todas as imagens Supabase da landing (comportamento legacy).
   * Formato: array de URLs completas (https://...supabase.co/...) OU
   * paths internos (asset.webp) — normaliza ambos por objectPath.
   */
  selectedUrls?: string[] | null;
}

/**
 * Parseia URL pública Supabase pra extrair o objectPath dentro do bucket.
 * Exemplo:
 *   https://xxx.supabase.co/storage/v1/object/public/cloned-landings/landings/{id}/asset.webp
 *   → 'landings/{id}/asset.webp'
 *
 * Retorna null se a URL não bater com o formato Supabase Storage public.
 */
function parseSupabasePath(url: string, bucket: string): string | null {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const path = url.slice(idx + marker.length);
  // Strip query string se houver (?token=... etc)
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

/**
 * StorageAdapter que lê/escreve no Supabase Storage bucket 'cloned-landings'.
 * As URLs vêm em formato getPublicUrl() (com /storage/v1/object/public/...).
 */
function supabaseStorageAdapter(bucket: string): StorageAdapter {
  const supabase = getSupabaseAdmin();
  return {
    readAsset: async (url: string): Promise<Buffer> => {
      const path = parseSupabasePath(url, bucket);
      if (!path) {
        throw new Error(`URL fora do bucket Supabase ${bucket}: ${url}`);
      }
      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error || !data) {
        throw new Error(`Supabase download failed for ${path}: ${error?.message ?? 'no data'}`);
      }
      const arrayBuffer = await data.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },
    writeAsset: async (url: string, buffer: Buffer): Promise<void> => {
      const path = parseSupabasePath(url, bucket);
      if (!path) {
        throw new Error(`URL fora do bucket Supabase ${bucket}: ${url}`);
      }
      // Content-type inferido pela extensão (Supabase serve com esse header).
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      const contentType =
        ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'png'
            ? 'image/png'
            : ext === 'webp'
              ? 'image/webp'
              : ext === 'gif'
                ? 'image/gif'
                : ext === 'avif'
                  ? 'image/avif'
                  : 'application/octet-stream';
      const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
        contentType,
        upsert: true,
        cacheControl: '31536000, immutable',
      });
      if (error) {
        throw new Error(`Supabase upload failed for ${path}: ${error.message}`);
      }
    },
  };
}

export async function processLandingLabTranslateImages(
  job: Job<LandingLabTranslateImagesJobData>,
): Promise<{
  ok: true;
  translated: number;
  skipped: number;
  failed: number;
  costUsd: number;
  latencyMs: number;
}> {
  const { landingPageId, targetLanguage } = job.data;
  const sourceLanguage = job.data.sourceLanguage ?? 'auto';
  const minWords = job.data.minWords ?? 3;
  // Confidence threshold: 20 é permissivo o suficiente pra pegar texto em
  // idiomas non-latin (jpn/chi/ara) onde tesseract retorna scores baixos
  // mesmo com texto legível. Landings dropship muitas vezes têm confidence
  // 20-35 mas texto correto quando o modelo bate com o idioma.
  const minConfidence = job.data.minConfidence ?? 20;
  const startedAt = Date.now();

  logger.info(
    { jobId: job.id, landingPageId, targetLanguage },
    'landinglab.translate-images: started',
  );

  const { db, sql: sqlEnd } = createClient({
    databaseUrl:
      process.env['DATABASE_URL'] ??
      'postgresql://blackshop:changeme@localhost:5432/blackshop',
  });

  // Helper pra escrever progresso na coluna jsonb (UI polleia essa row).
  // Faz UPDATE com jsonb concat pra preservar keys anteriores.
  const writeProgress = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      const patchJson = JSON.stringify({ ...patch, lastUpdatedAt: new Date().toISOString() });
      await db
        .update(landingPages)
        .set({
          translationProgress: sql`translation_progress || ${patchJson}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)));
    } catch (err) {
      logger.warn({ jobId: job.id, err }, 'writeProgress failed (non-fatal)');
    }
  };

  try {
    // 1. Query landing pra pegar mediaUrls + brand fields
    const [row] = await db
      .select({
        mediaUrls: landingPages.mediaUrls,
        brandFrom: landingPages.brandFrom,
        brandTo: landingPages.brandTo,
        targetDemographic: landingPages.targetDemographic,
      })
      .from(landingPages)
      .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)))
      .limit(1);

    if (!row) {
      throw new Error(`Landing ${landingPageId} não encontrada`);
    }

    // Filtra só URLs Supabase do bucket cloned-landings — evita processar
    // imagens externas (CDNs de terceiros) que não são nossas pra reescrever.
    let imageUrls = (row.mediaUrls ?? []).filter((u): u is string => {
      if (typeof u !== 'string') return false;
      return parseSupabasePath(u, CLONE_BUCKET) !== null;
    });

    // Se job.data.selectedUrls foi passado, aplica whitelist. Compara por
    // objectPath (path dentro do bucket) pra ser resistente a diferenças
    // de encoding/query string. Se selectedUrls é null/undefined, mantém
    // comportamento legacy (traduzir todas).
    if (Array.isArray(job.data.selectedUrls) && job.data.selectedUrls.length > 0) {
      const wantedPaths = new Set(
        job.data.selectedUrls
          .map((u) => parseSupabasePath(u, CLONE_BUCKET))
          .filter((p): p is string => p !== null),
      );
      const beforeCount = imageUrls.length;
      imageUrls = imageUrls.filter((u) => {
        const p = parseSupabasePath(u, CLONE_BUCKET);
        return p !== null && wantedPaths.has(p);
      });
      logger.info(
        {
          jobId: job.id,
          landingPageId,
          selectedUrls: job.data.selectedUrls.length,
          wantedPaths: wantedPaths.size,
          beforeCount,
          afterCount: imageUrls.length,
        },
        'landinglab.translate-images: whitelist selectedUrls applied',
      );
    }

    if (imageUrls.length === 0) {
      logger.info(
        { jobId: job.id, landingPageId },
        'landinglab.translate-images: no images to translate — marking done',
      );
      await db
        .update(landingPages)
        .set({
          translationStatus: 'done',
          translationProgress: sql`jsonb_build_object(
            'phase', 'complete',
            'imagesTotal', 0,
            'imagesDone', 0,
            'imagesFailed', 0,
            'imagesSkipped', 0,
            'costUsd', 0,
            'message', 'Nenhuma imagem embutida pra traduzir',
            'lastUpdatedAt', ${new Date().toISOString()}::text
          )`,
          updatedAt: new Date(),
        })
        .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)));

      return {
        ok: true,
        translated: 0,
        skipped: 0,
        failed: 0,
        costUsd: 0,
        latencyMs: Date.now() - startedAt,
      };
    }

    // 2. Marca status images_running + zera progresso
    await db
      .update(landingPages)
      .set({
        translationStatus: 'images_running',
        translationProgress: sql`jsonb_build_object(
          'phase', 'images:starting',
          'imagesTotal', ${imageUrls.length}::int,
          'imagesDone', 0,
          'imagesFailed', 0,
          'imagesSkipped', 0,
          'costUsd', 0,
          'lastUpdatedAt', ${new Date().toISOString()}::text
        )`,
        updatedAt: new Date(),
      })
      .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)));

    // 3. Roda translator com adapter Supabase
    const storage = supabaseStorageAdapter(CLONE_BUCKET);

    // Progresso é acumulado localmente e pushed pro DB em pontos-chave
    // (evita 3+ writes por imagem — só quando algo muda materialmente).
    let imagesDone = 0;
    let imagesFailed = 0;
    let imagesSkipped = 0;

    const brandFrom = job.data.brandFrom ?? row.brandFrom ?? null;
    const brandTo = job.data.brandTo ?? row.brandTo ?? null;
    const targetDemographic =
      job.data.targetDemographic ?? row.targetDemographic ?? null;

    const result = await translateImages({
      landingId: landingPageId,
      imageUrls,
      // Não usados quando storage adapter está setado, mas obrigatórios no
      // shape do input (backward-compat). Passa valores dummy.
      storageRoot: '/dev/null-worker',
      publicPathPrefix: '/cloned',
      publicBaseUrl: 'https://worker.local',
      storage,
      sourceLanguage,
      targetLanguage,
      minWordsThreshold: minWords,
      minOcrConfidence: minConfidence,
      brandFrom,
      brandTo,
      targetDemographic,
      onProgress: (event) => {
        // Atualiza contadores + escreve progresso a cada transição
        // materialmente relevante (start/done/failed/skipped por imagem).
        if (event.phase === 'image:done') {
          imagesDone++;
          void writeProgress({
            phase: 'images:running',
            imagesDone,
            imagesFailed,
            imagesSkipped,
            currentIndex: event.index,
          });
        } else if (event.phase === 'image:failed') {
          imagesFailed++;
          void writeProgress({
            phase: 'images:running',
            imagesDone,
            imagesFailed,
            imagesSkipped,
            currentIndex: event.index,
            lastError: event.error?.slice(0, 200),
          });
        } else if (event.phase === 'image:skipped') {
          imagesSkipped++;
          void writeProgress({
            phase: 'images:running',
            imagesDone,
            imagesFailed,
            imagesSkipped,
            currentIndex: event.index,
          });
        } else if (event.phase === 'image:start') {
          void writeProgress({
            phase: 'images:processing',
            currentIndex: event.index,
            currentUrl: event.localPath,
          });
        }
        void job
          .updateProgress({
            phase: event.phase,
            index: 'index' in event ? event.index : undefined,
            imagesDone,
            imagesFailed,
            imagesSkipped,
          })
          .catch(() => {});
      },
    });

    // 4. Marca terminal state — done_with_warnings se houve qualquer falha
    const finalStatus: 'done' | 'done_with_warnings' =
      result.failed > 0 ? 'done_with_warnings' : 'done';

    await db
      .update(landingPages)
      .set({
        translationStatus: finalStatus,
        translationProgress: sql`jsonb_build_object(
          'phase', 'complete',
          'imagesTotal', ${imageUrls.length}::int,
          'imagesDone', ${result.translated}::int,
          'imagesFailed', ${result.failed}::int,
          'imagesSkipped', ${result.skipped}::int,
          'costUsd', ${result.totalCostUsd}::numeric,
          'latencyMs', ${result.totalLatencyMs}::int,
          'warnings', ${result.failed > 0 ? `${result.failed} imagem(ns) falharam ao traduzir` : null}::text,
          'lastUpdatedAt', ${new Date().toISOString()}::text
        )`,
        updatedAt: new Date(),
      })
      .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)));

    const latencyMs = Date.now() - startedAt;
    logger.info(
      {
        jobId: job.id,
        landingPageId,
        translated: result.translated,
        skipped: result.skipped,
        failed: result.failed,
        costUsd: result.totalCostUsd,
        latencyMs,
        finalStatus,
      },
      'landinglab.translate-images: completed',
    );

    return {
      ok: true,
      translated: result.translated,
      skipped: result.skipped,
      failed: result.failed,
      costUsd: result.totalCostUsd,
      latencyMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { jobId: job.id, landingPageId, err, message },
      'landinglab.translate-images: failed',
    );
    // Marca failed no DB (não deixa em images_running órfão)
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

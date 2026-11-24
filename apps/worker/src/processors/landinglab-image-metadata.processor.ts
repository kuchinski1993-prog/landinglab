// Processor pra extrair OCR + Vision metadata das imagens da landing.
//
// Desacoplado do clone processor (set/2026): clone termina em ~90s,
// enfileira ImageMetadataJob. Este processor roda em background (5-10min
// pra landing com 300 imgs) e atualiza landing_pages.image_ocr_metadata
// quando termina. Wizard V2 Step 2 mostra spinner enquanto metadata
// ainda não está pronto.
//
// Vantagens da separação:
//   - Clone HTTP response volta em ~90s (dentro do timeout Vercel 5min SSE)
//   - Usuário pode navegar landing/wizard enquanto vision roda
//   - Se vision falhar, clone não é invalidado
//   - Retry independente do clone

import { createClient, landingPages } from '@blackshop/db';
import {
  classifyImages,
  extractImageOcrMetadata,
} from '@blackshop/landinglab-cloner';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';

import { logger } from '../logger.js';

export interface ImageMetadataJobData {
  landingPageId: string;
  /** Marca origem detectada no clone (usada pra flagar hasBrandOrigin). */
  brandOrigin: string | null;
  /** Idioma detectado da landing pra OCR (ex: 'ja'|'en'). Default 'en'. */
  sourceLanguage: string;
  /** URLs das imagens (Supabase Storage). */
  imageUrls: string[];
}

export interface ImageMetadataJobResult {
  ok: boolean;
  imagesCount: number;
  ocrRelevant: number;
  visionRelevant: number;
  visionCostUsd: number;
  latencyMs: number;
  errors: number;
}

export async function processImageMetadataJob(
  job: Job<ImageMetadataJobData, ImageMetadataJobResult, string>,
): Promise<ImageMetadataJobResult> {
  const started = Date.now();
  const { landingPageId, brandOrigin, sourceLanguage, imageUrls } = job.data;

  logger.info(
    { jobId: job.id, landingPageId, imagesCount: imageUrls.length },
    'landinglab.image-metadata: started',
  );

  if (imageUrls.length === 0) {
    return { ok: true, imagesCount: 0, ocrRelevant: 0, visionRelevant: 0, visionCostUsd: 0, latencyMs: 0, errors: 0 };
  }

  const { db, sql: sqlEnd } = createClient({
    databaseUrl:
      process.env['DATABASE_URL'] ??
      'postgresql://blackshop:changeme@localhost:5432/blackshop',
  });

  try {

  // OCR + Vision em paralelo (mesmo padrão do clone antes)
  const [ocrResults, visionResults] = await Promise.all([
    extractImageOcrMetadata({
      imageUrls,
      brandOrigin,
      sourceLanguage,
      concurrency: 4,
      onProgress: async (done, total) => {
        if (done % 20 === 0 || done === total) {
          await job.updateProgress({ phase: 'ocr', done, total });
        }
      },
    }).catch((err) => {
      logger.warn({ jobId: job.id, err }, 'image-metadata: OCR failed (non-fatal)');
      return [];
    }),
    classifyImages({
      imageUrls,
      concurrency: 3,
      onProgress: async (done, total) => {
        if (done % 20 === 0 || done === total) {
          await job.updateProgress({ phase: 'vision', done, total });
        }
      },
    }).catch((err) => {
      logger.warn({ jobId: job.id, err }, 'image-metadata: Vision failed (non-fatal)');
      return { items: [], costUsd: 0, latencyMs: 0, errors: imageUrls.length };
    }),
  ]);

  // Merge por URL
  const ocrByUrl = new Map<string, Record<string, unknown>>();
  for (const item of ocrResults) {
    ocrByUrl.set(item.url, item as unknown as Record<string, unknown>);
  }
  const visionByUrl = new Map<string, Record<string, unknown>>();
  for (const item of visionResults.items) {
    visionByUrl.set(item.url, item as unknown as Record<string, unknown>);
  }

  const merged = imageUrls.map((url) => ({
    url,
    hasText: false,
    hasBrandOrigin: false,
    wordCount: 0,
    ocrTextPreview: '',
    ocrConfidence: 0,
    bytes: 0,
    isRelevant: true,
    category: 'unknown',
    relevanceConfidence: 0,
    relevanceReason: '',
    ...(ocrByUrl.get(url) ?? {}),
    ...(visionByUrl.get(url)
      ? {
          isRelevant: visionByUrl.get(url)!['relevant'],
          category: visionByUrl.get(url)!['category'],
          relevanceConfidence: visionByUrl.get(url)!['confidence'],
          relevanceReason: visionByUrl.get(url)!['reason'],
        }
      : {}),
  }));

  // Persiste no DB
  await db
    .update(landingPages)
    .set({
      imageOcrMetadata: merged as never,
      updatedAt: new Date(),
    })
    .where(eq(landingPages.id, landingPageId));

  const ocrRelevant = merged.filter((m) => m.hasText === true).length;
  const visionRelevant = merged.filter((m) => m.isRelevant === true).length;

  const result: ImageMetadataJobResult = {
    ok: true,
    imagesCount: imageUrls.length,
    ocrRelevant,
    visionRelevant,
    visionCostUsd: visionResults.costUsd,
    latencyMs: Date.now() - started,
    errors: visionResults.errors,
  };

  logger.info(
    { jobId: job.id, landingPageId, ...result },
    'landinglab.image-metadata: completed',
  );

    return result;
  } finally {
    await sqlEnd.end();
  }
}

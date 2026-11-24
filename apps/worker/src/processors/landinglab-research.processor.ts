// LandingLab Squad 1 (Product Research) processor — Story 13.3 AC9.
//
// Consumes queue 'landinglab.squad1.research':
//   1. INSERT landing_generation_runs (squad='product_research', status='queued')
//   2. UPDATE row → status='running', started_at=now()
//   3. Call runProductResearch(input, deps) — the LangGraph-lite orchestrator
//   4. On success:
//        - UPDATE run: status='completed', completed_at, cost_usd, duration_ms,
//                       agent_trace, output={ pir_document_id }
//        - UPDATE landing_pages.pir_document_id
//        - Enqueue landinglab.squad2.copy (unless needsHumanReview OR synth failed)
//   5. On thrown error:
//        - UPDATE run: status='failed', error=<message>
//        - Re-throw so BullMQ handles retry per its DEFAULT_JOB_OPTIONS

import { createClient } from '@blackshop/db';
import { landingGenerationRuns, landingPages } from '@blackshop/db';
import {
  createApifyClient,
  createCheerioClient,
  createClaudeVisionClient,
  createFirecrawlClient,
  createGeminiVisionClient,
  createPerplexityClient,
  createSerpApiClient,
  runProductResearch,
  type OrchestratorDeps,
  type RunProductResearchInput,
  type RunProductResearchOutput,
} from '@blackshop/landinglab-research';
import type { Job } from 'bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { logger } from '../logger.js';

export interface LandingLabResearchJobData {
  landingPageId: string;
  sourceType: 'aliexpress_link' | 'photo_upload' | 'other_url';
  sourceUrl: string | null;
  sourceImageUrl: string | null;
  targetLanguage: 'de' | 'it' | 'en' | 'es' | 'fr';
  hint: string | null;
}

// Injectable factory for tests. Prod path uses createProductionDeps().
export interface LandingLabResearchDeps {
  runProductResearch: (
    input: RunProductResearchInput,
    deps: OrchestratorDeps,
  ) => Promise<RunProductResearchOutput>;
  buildOrchestratorDeps: () => OrchestratorDeps;
  enqueueSquad2Copy: (payload: Squad2CopyJobPayload) => Promise<void>;
  // Test seam: injetar DB alternativa (evita conexão real em unit tests).
  createDbClient?: () => ReturnType<typeof createClient>;
}

export interface Squad2CopyJobPayload {
  landingPageId: string;
  pirDocumentId: string;
  targetLanguage: 'de' | 'it' | 'en' | 'es' | 'fr';
}

const SQUAD2_QUEUE_NAME = 'landinglab.squad2.copy';
const SQUAD2_JOB_NAME = 'CopyGenerationJob';

// Factory pra deps de produção — injeta clients HTTP reais + orchestrator real.
export function createProductionDeps(): LandingLabResearchDeps {
  return {
    runProductResearch,
    buildOrchestratorDeps: (): OrchestratorDeps => {
      const { db } = createClient({
        databaseUrl:
          process.env['DATABASE_URL'] ??
          'postgresql://blackshop:changeme@localhost:5432/blackshop',
      });
      // Vision provider selection:
      // - Gemini 2.0 Flash (default): ~200x mais barato que Claude Opus vision.
      //   Ativa quando LANDINGLAB_GEMINI_KEY (ou GEMINI_API_KEY / GOOGLE_API_KEY)
      //   está setado. Vision-verifier usa como primary + cai pra Claude como
      //   fallback quando Gemini falha.
      // - Claude Opus (fallback): usado pelo vision-verifier em fallback e
      //   pelo pir-synthesizer (Sage) que ainda depende de Opus pra synth final.
      const hasGeminiKey = Boolean(
        process.env['LANDINGLAB_GEMINI_KEY'] ??
          process.env['GEMINI_API_KEY'] ??
          process.env['GOOGLE_API_KEY'],
      );
      return {
        serpapi: createSerpApiClient(),
        cheerio: createCheerioClient(),
        firecrawl: createFirecrawlClient(),
        apify: createApifyClient(),
        perplexity: createPerplexityClient(),
        claude: createClaudeVisionClient(),
        gemini: hasGeminiKey ? createGeminiVisionClient() : undefined,
        db,
      };
    },
    enqueueSquad2Copy: defaultEnqueueSquad2Copy,
  };
}

// Enqueue Squad 2 (Copy) — fire-and-forget curto-lived connection.
async function defaultEnqueueSquad2Copy(payload: Squad2CopyJobPayload): Promise<void> {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  try {
    const queue = new Queue(SQUAD2_QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential' as const, delay: 5_000 },
      },
    });
    await queue.add(SQUAD2_JOB_NAME, payload, {
      jobId: `lp-copy-${payload.landingPageId}-${payload.pirDocumentId}`,
    });
    await queue.close();
  } finally {
    await redis.quit();
  }
}

/**
 * BullMQ processor factory. Aceita deps injetáveis pra unit tests.
 * Em produção, o worker chama `makeLandingLabResearchProcessor(createProductionDeps())`.
 */
export function makeLandingLabResearchProcessor(
  deps: LandingLabResearchDeps = createProductionDeps(),
): (job: Job<LandingLabResearchJobData>) => Promise<{ ok: true; runId: string }> {
  return async function landingLabResearchProcessor(
    job: Job<LandingLabResearchJobData>,
  ): Promise<{ ok: true; runId: string }> {
    const started = Date.now();
    const { landingPageId } = job.data;
    logger.info(
      { jobId: job.id, landingPageId, sourceType: job.data.sourceType },
      'landinglab.squad1.research job started',
    );

    const createDb = deps.createDbClient ?? ((): ReturnType<typeof createClient> =>
      createClient({
        databaseUrl:
          process.env['DATABASE_URL'] ??
          'postgresql://blackshop:changeme@localhost:5432/blackshop',
      }));
    const { db, sql } = createDb();

    // ─── Step 1: INSERT run row (status=queued → running) ───────────────────
    let runId = '';
    try {
      const now = new Date();
      const [inserted] = await db
        .insert(landingGenerationRuns)
        .values({
          landingPageId,
          squad: 'product_research',
          status: 'running',
          input: job.data as unknown as Record<string, unknown>,
          startedAt: now,
        })
        .returning({ id: landingGenerationRuns.id });
      if (!inserted) throw new Error('failed to insert landing_generation_runs row');
      runId = inserted.id;
      logger.info({ jobId: job.id, runId, landingPageId }, 'run row created (running)');

      // ─── Step 2: Call orchestrator ────────────────────────────────────────
      const orchestratorDeps = deps.buildOrchestratorDeps();
      // Ao usar orchestratorDeps de produção, o db orchestrator = db do processor.
      // Em tests injetados, deps.buildOrchestratorDeps() pode retornar um db diferente
      // (mock/fake) — não é problema porque Sage persiste em landing_pir_documents
      // via SEU db (não o db do processor).

      const input: RunProductResearchInput = {
        landingPageId,
        sourceType: job.data.sourceType,
        sourceUrl: job.data.sourceUrl,
        sourceImageUrl: job.data.sourceImageUrl,
        targetLanguage: job.data.targetLanguage,
        hint: job.data.hint,
      };

      const result = await deps.runProductResearch(input, orchestratorDeps);

      // ─── Step 3: Persist result to run row + landing_pages ────────────────
      const completedAt = new Date();
      const totalDurationMs = Date.now() - started;
      const finalStatus =
        result.pirDocumentId && !result.needsHumanReview ? 'completed' : 'failed';
      const errorMsg = result.needsHumanReview
        ? 'needs_human_review (lens/vision below confidence threshold or synth failed)'
        : result.pirDocumentId
          ? null
          : 'synth_failed';

      await db
        .update(landingGenerationRuns)
        .set({
          status: finalStatus,
          completedAt,
          costUsd: String(result.costUsd.toFixed(4)),
          durationMs: totalDurationMs,
          agentTrace: result.agentTrace as unknown as Record<string, unknown>,
          output: { pirDocumentId: result.pirDocumentId } as unknown as Record<string, unknown>,
          error: errorMsg,
        })
        .where(eq(landingGenerationRuns.id, runId));

      // Atualiza landing_pages.pir_document_id se temos PIR persistido.
      if (result.pirDocumentId) {
        await db
          .update(landingPages)
          .set({ pirDocumentId: result.pirDocumentId, updatedAt: new Date() })
          .where(eq(landingPages.id, landingPageId));
      }

      logger.info(
        {
          jobId: job.id,
          runId,
          landingPageId,
          status: finalStatus,
          costUsd: result.costUsd,
          durationMs: totalDurationMs,
          pirDocumentId: result.pirDocumentId,
          mode: result.mode,
          needsHumanReview: result.needsHumanReview,
        },
        'landinglab.squad1.research job completed',
      );

      // ─── Step 4: Enqueue Squad 2 (Copy) — só se PIR sólido ────────────────
      if (finalStatus === 'completed' && result.pirDocumentId) {
        try {
          await deps.enqueueSquad2Copy({
            landingPageId,
            pirDocumentId: result.pirDocumentId,
            targetLanguage: job.data.targetLanguage,
          });
        } catch (err) {
          // Enqueue de Squad 2 é fire-and-forget. Se falha, log warning, não
          // derruba o job — Squad 1 CONCLUIU. Dono pode re-disparar via UI.
          logger.warn(
            { err, jobId: job.id, landingPageId },
            'failed to enqueue landinglab.squad2.copy — Squad 1 done, re-run manually',
          );
        }
      }

      return { ok: true, runId };
    } catch (err) {
      // Erro inesperado (rede DB, orchestrator throws imprevisto).
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, jobId: job.id, landingPageId, runId },
        'landinglab.squad1.research job failed',
      );
      if (runId) {
        try {
          await db
            .update(landingGenerationRuns)
            .set({
              status: 'failed',
              completedAt: new Date(),
              durationMs: Date.now() - started,
              error: errorMsg,
            })
            .where(eq(landingGenerationRuns.id, runId));
        } catch (updateErr) {
          logger.error(
            { err: updateErr, runId },
            'failed to mark run as failed (double failure)',
          );
        }
      }
      // Re-throw pra BullMQ decidir retry.
      throw err;
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
}

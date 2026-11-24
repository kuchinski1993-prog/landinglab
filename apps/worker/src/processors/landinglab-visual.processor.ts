// LandingLab Squad 3 (Visual & Brand Forge) processor — Story 13.5 AC17/AC18/AC28.
//
// Consumes queue 'landinglab.squad3.design' (job name 'DesignGenerationJob'):
//   1. Load PIR (via pirDocumentId) + CopyDeck EN (via copyDeckIds + landingPageId).
//   2. INSERT landing_generation_runs (squad='visual', status='running').
//   3. Call runVisualSquad({ landingPageId, pirDocumentId, copyDeckIds, languages, pir, copyDeck }, deps).
//   4. On success:
//        - UPDATE run → status='completed', cost, duration, agent_trace, output.
//        - Enqueue Squad 4 (landinglab.squad4.build) — fire-and-forget.
//   5. On failure (incl. hero-mandatory abort):
//        - UPDATE run → status='failed', error=<msg>.
//        - No Squad 4 enqueue.
//
// Factory pattern (deps injectable) mirrors Squads 1+2. Prod path uses createProductionDeps().
//
// visual_assets_id não é persistido em landing_pages (nenhuma FK adicionada em
// migration 0049). Squad 4 lê via `SELECT * FROM landing_visual_assets WHERE
// landing_page_id = X ORDER BY version DESC LIMIT 1` — mesmo padrão que copy decks.

import { createClient } from '@blackshop/db';
import { landingCopyDecks, landingGenerationRuns, landingPirDocuments } from '@blackshop/db';
import {
  createClaudeTextClient,
  createFreepikProvider,
  createHiggsfieldProvider,
  runVisualSquad,
  type RunVisualSquadInput,
  type RunVisualSquadOutput,
  type VisualSquadDeps,
} from '@blackshop/landinglab-visual';
import type { Job } from 'bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { logger } from '../logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type CopyLanguage = 'de' | 'it' | 'en' | 'es' | 'fr';

/**
 * Job payload emitted by Squad 2 (landinglab-copy.processor.ts:
 * Squad3DesignJobPayload).
 */
export interface LandingLabVisualJobData {
  landingPageId: string;
  pirDocumentId: string;
  copyDeckIds: string[];
  languages: CopyLanguage[];
  previousRunId?: string;
}

export interface Squad4BuildJobPayload {
  landingPageId: string;
  pirDocumentId: string;
  copyDeckIds: string[];
  languages: CopyLanguage[];
  visualAssetsId: string;
}

// Injectable factory for tests.
export interface LandingLabVisualDeps {
  runVisualSquad: (
    input: RunVisualSquadInput,
    deps: VisualSquadDeps,
  ) => Promise<RunVisualSquadOutput>;
  buildVisualSquadDeps: () => VisualSquadDeps;
  enqueueSquad4Build: (payload: Squad4BuildJobPayload) => Promise<void>;
  createDbClient?: () => ReturnType<typeof createClient>;
}

// ─── Constants ────────────────────────────────────────────────────────────

const SQUAD4_QUEUE_NAME = 'landinglab.squad4.build';
const SQUAD4_JOB_NAME = 'BuildHtmlJob';

// ─── Production deps ─────────────────────────────────────────────────────

export function createProductionDeps(): LandingLabVisualDeps {
  return {
    runVisualSquad,
    buildVisualSquadDeps: (): VisualSquadDeps => {
      const { db } = createClient({
        databaseUrl:
          process.env['DATABASE_URL'] ??
          'postgresql://blackshop:changeme@localhost:5432/blackshop',
      });
      return {
        claude: createClaudeTextClient(),
        imageProvider: createFreepikProvider(),
        fallbackProvider: createHiggsfieldProvider(),
        db,
      };
    },
    enqueueSquad4Build: defaultEnqueueSquad4Build,
  };
}

async function defaultEnqueueSquad4Build(payload: Squad4BuildJobPayload): Promise<void> {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  try {
    const queue = new Queue(SQUAD4_QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential' as const, delay: 5_000 },
      },
    });
    await queue.add(SQUAD4_JOB_NAME, payload, {
      jobId: `lp-build-${payload.landingPageId}-${payload.visualAssetsId}`,
    });
    await queue.close();
  } finally {
    await redis.quit();
  }
}

// ─── Processor factory ───────────────────────────────────────────────────

/**
 * BullMQ processor factory. Deps injectable for unit tests.
 * Prod: `makeLandingLabVisualProcessor(createProductionDeps())`.
 */
export function makeLandingLabVisualProcessor(
  deps: LandingLabVisualDeps = createProductionDeps(),
): (job: Job<LandingLabVisualJobData>) => Promise<{
  ok: true;
  runId: string;
  visualAssetsId: string;
  costUsd: number;
  durationMs: number;
}> {
  return async function landingLabVisualProcessor(job) {
    const started = Date.now();
    const { landingPageId, pirDocumentId, copyDeckIds, languages } = job.data;
    logger.info(
      { jobId: job.id, landingPageId, pirDocumentId, copyDeckIds, languages },
      'landinglab.squad3.design job started',
    );

    const createDb =
      deps.createDbClient ??
      ((): ReturnType<typeof createClient> =>
        createClient({
          databaseUrl:
            process.env['DATABASE_URL'] ??
            'postgresql://blackshop:changeme@localhost:5432/blackshop',
        }));
    const { db, sql } = createDb();

    let runId = '';

    try {
      // ─── Step 1: Insert run row (status='running') ──────────────────────
      const [inserted] = await db
        .insert(landingGenerationRuns)
        .values({
          landingPageId,
          squad: 'visual',
          status: 'running',
          input: {
            pirDocumentId,
            copyDeckIds,
            languages,
            previousRunId: job.data.previousRunId ?? null,
          } as unknown as Record<string, unknown>,
          startedAt: new Date(),
        })
        .returning({ id: landingGenerationRuns.id });
      if (!inserted) throw new Error('failed to insert landing_generation_runs row');
      runId = inserted.id;

      // ─── Step 2: Pre-load PIR + CopyDeck EN for perf ─────────────────────
      // (Orchestrator accepts pir/copyDeck in input; skips DB roundtrip when provided.)
      let pir: unknown = undefined;
      let copyDeck: unknown = undefined;
      try {
        const pirRows = await db
          .select({ content: landingPirDocuments.content })
          .from(landingPirDocuments)
          .where(eq(landingPirDocuments.id, pirDocumentId))
          .limit(1);
        pir = pirRows[0]?.content;

        const deckRows = await db
          .select({
            id: landingCopyDecks.id,
            content: landingCopyDecks.content,
            language: landingCopyDecks.language,
          })
          .from(landingCopyDecks)
          .where(eq(landingCopyDecks.landingPageId, landingPageId));
        const enDeck = deckRows.find((r) => r.language === 'en');
        copyDeck = enDeck?.content ?? deckRows[0]?.content;
      } catch (loadErr) {
        // Pre-load falhou: orchestrator faz próprio fetch (fallback path).
        logger.warn(
          { err: loadErr, jobId: job.id, landingPageId, pirDocumentId },
          'pre-load of PIR/CopyDeck failed — orchestrator will re-fetch',
        );
      }

      // ─── Step 3: Call orchestrator ───────────────────────────────────────
      const squadDeps = deps.buildVisualSquadDeps();
      const input: RunVisualSquadInput = {
        landingPageId,
        pirDocumentId,
        copyDeckIds,
        languages,
        ...(pir ? { pir } : {}),
        ...(copyDeck ? { copyDeck } : {}),
      };

      const result = await deps.runVisualSquad(input, squadDeps);

      // ─── Step 4: Persist success ─────────────────────────────────────────
      await db
        .update(landingGenerationRuns)
        .set({
          status: 'completed',
          completedAt: new Date(),
          costUsd: String(result.costUsd.toFixed(4)),
          durationMs: Date.now() - started,
          agentTrace: result.agentTrace as unknown as Record<string, unknown>,
          output: {
            visualAssetsId: result.visualAssetsId,
            brandName: result.brand.name,
            directorNotes: result.directorNotes,
          } as unknown as Record<string, unknown>,
        })
        .where(eq(landingGenerationRuns.id, runId));

      // ─── Step 5: Enqueue Squad 4 (Build) ────────────────────────────────
      try {
        await deps.enqueueSquad4Build({
          landingPageId,
          pirDocumentId,
          copyDeckIds,
          languages,
          visualAssetsId: result.visualAssetsId,
        });
      } catch (enqueueErr) {
        logger.warn(
          { err: enqueueErr, jobId: job.id, landingPageId, visualAssetsId: result.visualAssetsId },
          'failed to enqueue landinglab.squad4.build — Squad 3 done, re-run manually',
        );
      }

      logger.info(
        {
          jobId: job.id,
          runId,
          landingPageId,
          visualAssetsId: result.visualAssetsId,
          costUsd: result.costUsd,
          durationMs: Date.now() - started,
        },
        'landinglab.squad3.design job completed',
      );

      return {
        ok: true,
        runId,
        visualAssetsId: result.visualAssetsId,
        costUsd: result.costUsd,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, jobId: job.id, runId, landingPageId },
        'landinglab.squad3.design job failed',
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
            'failed to mark visual run as failed (double failure)',
          );
        }
      }
      // Rethrow so BullMQ marks the job as failed (respects retry policy).
      throw err;
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
}

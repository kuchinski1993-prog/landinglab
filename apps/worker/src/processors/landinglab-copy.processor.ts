// LandingLab Squad 2 (Copy High-Conversion) processor — Story 13.4 AC16/AC17/AC22.
//
// Consumes queue 'landinglab.squad2.copy':
//   1. Load landing_pages row → resolve target_languages array (default ['en']).
//   2. Ensure order: EN first, then remaining alpha (AC22).
//   3. Loop sequentially per language:
//        a. INSERT landing_generation_runs (squad='copy', status='queued'|'running')
//        b. Call runCopySquad({ landingPageId, pirDocumentId, language }, deps)
//        c. UPDATE row → status='completed'|'failed', cost, duration, agent_trace, output
//   4. Aggregate cost + traces across all languages.
//   5. Enqueue Squad 3 (design) IFF EN succeeded, with copyDeckIds + languages arrays.
//        - EN failure → abort, no Squad 3 enqueue (marks critical failure).
//        - Non-EN failure → log gap, continue with next languages.
//
// Factory pattern (deps injectable) mirrors Squad 1
// (makeLandingLabResearchProcessor). Prod path uses createProductionDeps().

import { createClient } from '@blackshop/db';
import { landingGenerationRuns, landingPages } from '@blackshop/db';
import {
  createClaudeTextClient,
  runCopySquad,
  type CopySquadDeps,
  type RunCopySquadInput,
  type RunCopySquadOutput,
} from '@blackshop/landinglab-copy';
import type { Job } from 'bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { logger } from '../logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Job payload emitted by Squad 1 (see landinglab-research.processor.ts
 * Squad2CopyJobPayload). `targetLanguage` is the singular research language
 * from Squad 1; the multi-language array lives in landing_pages.target_languages
 * and is resolved inside the processor.
 */
export interface LandingLabCopyJobData {
  landingPageId: string;
  pirDocumentId: string;
  targetLanguage: 'de' | 'it' | 'en' | 'es' | 'fr';
  previousRunId?: string;
}

export type CopyLanguage = 'de' | 'it' | 'en' | 'es' | 'fr';

export interface Squad3DesignJobPayload {
  landingPageId: string;
  pirDocumentId: string;
  /** UUIDs of successfully generated copy decks, ordered by `languages`. */
  copyDeckIds: string[];
  /** Languages actually generated (subset of target_languages). */
  languages: CopyLanguage[];
}

// Injectable factory for tests.
export interface LandingLabCopyDeps {
  runCopySquad: (
    input: RunCopySquadInput,
    deps: CopySquadDeps,
  ) => Promise<RunCopySquadOutput>;
  buildCopySquadDeps: () => CopySquadDeps;
  enqueueSquad3Design: (payload: Squad3DesignJobPayload) => Promise<void>;
  createDbClient?: () => ReturnType<typeof createClient>;
}

// ─── Constants ────────────────────────────────────────────────────────────

const SQUAD3_QUEUE_NAME = 'landinglab.squad3.design';
const SQUAD3_JOB_NAME = 'DesignGenerationJob';

const VALID_LANGUAGES: readonly CopyLanguage[] = ['en', 'de', 'it', 'fr', 'es'];

// ─── Production deps ─────────────────────────────────────────────────────

export function createProductionDeps(): LandingLabCopyDeps {
  return {
    runCopySquad,
    buildCopySquadDeps: (): CopySquadDeps => {
      const { db } = createClient({
        databaseUrl:
          process.env['DATABASE_URL'] ??
          'postgresql://blackshop:changeme@localhost:5432/blackshop',
      });
      return {
        claude: createClaudeTextClient(),
        db,
      };
    },
    enqueueSquad3Design: defaultEnqueueSquad3Design,
  };
}

// Enqueue Squad 3 (Design) — fire-and-forget short-lived connection.
async function defaultEnqueueSquad3Design(payload: Squad3DesignJobPayload): Promise<void> {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  try {
    const queue = new Queue(SQUAD3_QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential' as const, delay: 5_000 },
      },
    });
    await queue.add(SQUAD3_JOB_NAME, payload, {
      jobId: `lp-design-${payload.landingPageId}-${payload.pirDocumentId}`,
    });
    await queue.close();
  } finally {
    await redis.quit();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Normalize target_languages array:
 *   - Empty/null → default to ['en'].
 *   - Filter out invalid entries.
 *   - Dedupe.
 *   - Ensure 'en' present (always).
 *   - Order: 'en' first, then remaining alphabetically (AC22).
 */
export function normalizeTargetLanguages(
  raw: string[] | null | undefined,
): CopyLanguage[] {
  const seen = new Set<CopyLanguage>();
  const entries: CopyLanguage[] = [];
  for (const lang of raw ?? []) {
    if (VALID_LANGUAGES.includes(lang as CopyLanguage) && !seen.has(lang as CopyLanguage)) {
      seen.add(lang as CopyLanguage);
      entries.push(lang as CopyLanguage);
    }
  }
  if (!seen.has('en')) {
    entries.unshift('en');
  }
  // Order: 'en' first, then rest alpha.
  const rest = entries.filter((l) => l !== 'en').sort();
  return ['en', ...rest];
}

// ─── Processor factory ───────────────────────────────────────────────────

/**
 * BullMQ processor factory. Deps injectable for unit tests.
 * Prod: `makeLandingLabCopyProcessor(createProductionDeps())`.
 */
export function makeLandingLabCopyProcessor(
  deps: LandingLabCopyDeps = createProductionDeps(),
): (job: Job<LandingLabCopyJobData>) => Promise<{
  ok: true;
  runIds: string[];
  copyDeckIds: string[];
  languages: CopyLanguage[];
  totalCostUsd: number;
}> {
  return async function landingLabCopyProcessor(job) {
    const started = Date.now();
    const { landingPageId, pirDocumentId } = job.data;
    logger.info(
      { jobId: job.id, landingPageId, pirDocumentId },
      'landinglab.squad2.copy job started',
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

    try {
      // ─── Step 1: Resolve target_languages ────────────────────────────────
      const lpRows = await db
        .select({ targetLanguages: landingPages.targetLanguages })
        .from(landingPages)
        .where(eq(landingPages.id, landingPageId))
        .limit(1);
      const lpRow = lpRows[0];
      if (!lpRow) {
        throw new Error(`landing_pages row not found: ${landingPageId}`);
      }
      const languages = normalizeTargetLanguages(lpRow.targetLanguages);
      logger.info(
        { jobId: job.id, landingPageId, languages },
        'squad2 languages resolved',
      );

      // ─── Step 2: Loop per language sequentially (AC22) ───────────────────
      const runIds: string[] = [];
      const copyDeckIds: string[] = [];
      const languagesGenerated: CopyLanguage[] = [];
      let totalCostUsd = 0;
      let enSucceeded = false;

      for (const language of languages) {
        const langStarted = Date.now();
        let runId = '';

        // Insert run row (status='running').
        try {
          const [inserted] = await db
            .insert(landingGenerationRuns)
            .values({
              landingPageId,
              squad: 'copy',
              status: 'running',
              input: {
                pirDocumentId,
                language,
                previousRunId: job.data.previousRunId ?? null,
              } as unknown as Record<string, unknown>,
              startedAt: new Date(),
            })
            .returning({ id: landingGenerationRuns.id });
          if (!inserted) throw new Error('failed to insert landing_generation_runs row');
          runId = inserted.id;
          runIds.push(runId);
        } catch (insertErr) {
          logger.error(
            { err: insertErr, jobId: job.id, landingPageId, language },
            'failed to insert copy run row — aborting language',
          );
          // If EN insert fails we're in trouble — throw so BullMQ retries.
          if (language === 'en') throw insertErr;
          continue;
        }

        // Call orchestrator.
        try {
          const squadDeps = deps.buildCopySquadDeps();
          const input: RunCopySquadInput = {
            landingPageId,
            pirDocumentId,
            language,
          };
          const result = await deps.runCopySquad(input, squadDeps);

          totalCostUsd += result.costUsd;
          copyDeckIds.push(result.copyDeckId);
          languagesGenerated.push(language);
          if (language === 'en') enSucceeded = true;

          await db
            .update(landingGenerationRuns)
            .set({
              status: 'completed',
              completedAt: new Date(),
              costUsd: String(result.costUsd.toFixed(4)),
              durationMs: Date.now() - langStarted,
              agentTrace: result.agentTrace as unknown as Record<string, unknown>,
              output: {
                copyDeckId: result.copyDeckId,
                language: result.language,
                chiefNotes: result.chiefNotes,
              } as unknown as Record<string, unknown>,
            })
            .where(eq(landingGenerationRuns.id, runId));

          logger.info(
            {
              jobId: job.id,
              runId,
              landingPageId,
              language,
              copyDeckId: result.copyDeckId,
              costUsd: result.costUsd,
              durationMs: Date.now() - langStarted,
            },
            'copy language completed',
          );
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error(
            { err, jobId: job.id, runId, landingPageId, language },
            'copy language failed',
          );
          try {
            await db
              .update(landingGenerationRuns)
              .set({
                status: 'failed',
                completedAt: new Date(),
                durationMs: Date.now() - langStarted,
                error: errorMsg,
              })
              .where(eq(landingGenerationRuns.id, runId));
          } catch (updateErr) {
            logger.error(
              { err: updateErr, runId },
              'failed to mark copy run as failed (double failure)',
            );
          }
          // AC22: EN failure aborts the whole job — Squad 3 will NOT be enqueued.
          if (language === 'en') {
            throw new Error(`EN copy generation failed: ${errorMsg}`);
          }
          // Non-EN failure: log gap, continue with remaining languages.
        }
      }

      // ─── Step 3: Enqueue Squad 3 (Design) ────────────────────────────────
      // AC22: only enqueue if EN succeeded AND we have at least one deck.
      if (enSucceeded && copyDeckIds.length > 0) {
        try {
          await deps.enqueueSquad3Design({
            landingPageId,
            pirDocumentId,
            copyDeckIds,
            languages: languagesGenerated,
          });
        } catch (enqueueErr) {
          logger.warn(
            { err: enqueueErr, jobId: job.id, landingPageId },
            'failed to enqueue landinglab.squad3.design — Squad 2 done, re-run manually',
          );
        }
      } else {
        logger.warn(
          { jobId: job.id, landingPageId, enSucceeded, copyDeckIds: copyDeckIds.length },
          'Squad 3 NOT enqueued — EN missing or no decks generated',
        );
      }

      logger.info(
        {
          jobId: job.id,
          landingPageId,
          languagesGenerated,
          copyDeckIds,
          totalCostUsd,
          durationMs: Date.now() - started,
        },
        'landinglab.squad2.copy job completed',
      );

      return {
        ok: true,
        runIds,
        copyDeckIds,
        languages: languagesGenerated,
        totalCostUsd,
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
}

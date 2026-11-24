// LandingLab Squad 4 (Build HTML) processor — Story 13.6 AC22/AC23/AC24/AC27.
//
// Consumes queue 'landinglab.squad4.build' (job name 'BuildHtmlJob'):
//   1. INSERT landing_generation_runs (squad='build', status='running').
//   2. Call runBuildSquad({ landingPageId, pirDocumentId, copyDeckIds, visualAssetsId, languages }, deps).
//   3. On success:
//        - UPDATE run → status='completed', cost, duration, agent_trace, output.
//        - NO downstream enqueue — Squad 4 is the terminal squad in this pipeline
//          (Story 13.7 will add Squad 5 Deploy later). Log a clear
//          "landing ready for review" success message.
//   4. On failure:
//        - UPDATE run → status='failed', error=<msg>.
//        - Rethrow so BullMQ marks the job as failed (respects retry policy).
//
// Factory pattern (deps injectable) mirrors Squads 1/2/3. Prod path uses
// createProductionDeps(). Claude Haiku client is instantiated at deps
// construction time (env LANDINGLAB_ANTHROPIC_KEY — same key as other squads).

import { createClient } from '@blackshop/db';
import { landingGenerationRuns } from '@blackshop/db';
import {
  createClaudeHaikuClient,
  runBuildSquad,
  type BuildSquadDeps,
  type RunBuildSquadInput,
  type RunBuildSquadOutput,
} from '@blackshop/landinglab-build';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';

import { logger } from '../logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type CopyLanguage = 'de' | 'it' | 'en' | 'es' | 'fr';

/**
 * Job payload emitted by Squad 3 (landinglab-visual.processor.ts:
 * Squad4BuildJobPayload).
 */
export interface LandingLabBuildJobData {
  landingPageId: string;
  pirDocumentId: string;
  copyDeckIds: string[];
  visualAssetsId: string;
  languages: CopyLanguage[];
}

// Injectable factory for tests.
export interface LandingLabBuildDeps {
  runBuildSquad: (
    input: RunBuildSquadInput,
    deps: BuildSquadDeps,
  ) => Promise<RunBuildSquadOutput>;
  buildBuildSquadDeps: () => BuildSquadDeps;
  createDbClient?: () => ReturnType<typeof createClient>;
}

// ─── Production deps ─────────────────────────────────────────────────────

export function createProductionDeps(): LandingLabBuildDeps {
  return {
    runBuildSquad,
    buildBuildSquadDeps: (): BuildSquadDeps => {
      const { db } = createClient({
        databaseUrl:
          process.env['DATABASE_URL'] ??
          'postgresql://blackshop:changeme@localhost:5432/blackshop',
      });
      // Same env var as other landinglab squads. When absent, the Haiku
      // client returns null on API calls and the SEO agent falls back to
      // deterministic meta description generation. Safe for dev/test.
      return {
        db,
        haiku: createClaudeHaikuClient(),
      };
    },
  };
}

// ─── Processor factory ───────────────────────────────────────────────────

/**
 * BullMQ processor factory. Deps injectable for unit tests.
 * Prod: `makeLandingLabBuildProcessor(createProductionDeps())`.
 */
export function makeLandingLabBuildProcessor(
  deps: LandingLabBuildDeps = createProductionDeps(),
): (job: Job<LandingLabBuildJobData>) => Promise<{
  ok: true;
  runId: string;
  languageVariantIds: string[];
  languagesGenerated: string[];
  costUsd: number;
  durationMs: number;
}> {
  return async function landingLabBuildProcessor(job) {
    const started = Date.now();
    const { landingPageId, pirDocumentId, copyDeckIds, visualAssetsId, languages } = job.data;
    logger.info(
      { jobId: job.id, landingPageId, pirDocumentId, copyDeckIds, visualAssetsId, languages },
      'landinglab.squad4.build job started',
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
          squad: 'build',
          status: 'running',
          input: {
            pirDocumentId,
            copyDeckIds,
            visualAssetsId,
            languages,
          } as unknown as Record<string, unknown>,
          startedAt: new Date(),
        })
        .returning({ id: landingGenerationRuns.id });
      if (!inserted) throw new Error('failed to insert landing_generation_runs row');
      runId = inserted.id;

      // ─── Step 2: Call orchestrator ───────────────────────────────────────
      const squadDeps = deps.buildBuildSquadDeps();
      const input: RunBuildSquadInput = {
        landingPageId,
        pirDocumentId,
        copyDeckIds,
        visualAssetsId,
        languages,
      };

      const result = await deps.runBuildSquad(input, squadDeps);

      // ─── Step 3: Persist success ─────────────────────────────────────────
      await db
        .update(landingGenerationRuns)
        .set({
          status: 'completed',
          completedAt: new Date(),
          costUsd: String(result.costUsd.toFixed(4)),
          durationMs: Date.now() - started,
          agentTrace: result.agentTrace as unknown as Record<string, unknown>,
          output: {
            languageVariantIds: result.languageVariantIds,
            languagesGenerated: result.languagesGenerated,
          } as unknown as Record<string, unknown>,
        })
        .where(eq(landingGenerationRuns.id, runId));

      // ─── Step 4: Terminal squad — NO downstream enqueue ──────────────────
      // Squad 4 is the last squad in the LandingLab AI Autopilot pipeline as
      // shipped in Epic 13. Story 13.7 will add Squad 5 (Deploy) later; until
      // then the landing is "ready for review" and the operator publishes
      // manually via the backoffice. Log a clear signal so ops can see the
      // pipeline reached completion.
      logger.info(
        {
          jobId: job.id,
          runId,
          landingPageId,
          languageVariantIds: result.languageVariantIds,
          languagesGenerated: result.languagesGenerated,
          costUsd: result.costUsd,
          durationMs: Date.now() - started,
        },
        'landinglab.squad4.build job completed — landing ready for review',
      );

      return {
        ok: true,
        runId,
        languageVariantIds: result.languageVariantIds,
        languagesGenerated: result.languagesGenerated,
        costUsd: result.costUsd,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, jobId: job.id, runId, landingPageId },
        'landinglab.squad4.build job failed',
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
            'failed to mark build run as failed (double failure)',
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

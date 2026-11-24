// LandingLab Squad 5 (Deploy) processor — Story 13.8 AC21/AC22/AC25.
//
// Consumes queue 'landinglab.squad5.deploy' (job name 'DeployLandingJob'):
//   1. Validate payload via DeployJobPayloadSchema (Zod — AC18).
//   2. INSERT landing_generation_runs (squad='deploy', status='running').
//   3. Call runDeploySquad({ landingPageId, deploymentId, deploymentType,
//      hostname, customDomain? }, deps) from @blackshop/landinglab-deploy.
//   4. Outcome handling (terminal squad — NO downstream enqueue):
//        - deploymentStatus='published' → run.status='completed', output={
//          deploymentId, hostname, publishedUrl }. Log "landing published".
//        - deploymentStatus='awaiting_ssl' → run.status='completed' (valid
//          intermediate state, NOT a failure). Landing_pages.status stays
//          'ready_for_review' (only orchestrator marks 'published' at the very
//          end). Log "SSL pending, operator retry via UI".
//        - result.ok=false (publish_failed) → run.status='failed', error=result.error,
//          agent_trace preserved, cost_usd preserved (semantic rollback — see
//          Story 13.8 §Deploy Chief rollback).
//        - uncaught error thrown → run.status='failed', error=<msg>, rethrow.
//
// Factory pattern (deps injectable) mirrors Squad 4. Prod path uses
// createProductionDeps(). Spaceship + Vercel clients instantiated at deps
// construction time via env vars: LANDINGLAB_SPACESHIP_API_KEY,
// LANDINGLAB_VERCEL_TOKEN, LANDINGLAB_VERCEL_PROJECT_ID.

import { createClient } from '@blackshop/db';
import { landingDeployments, landingGenerationRuns } from '@blackshop/db';
import {
  runDeploySquad,
  validateDeployJobPayload,
  createSpaceshipClient,
  type DeploySquadDeps,
  type RunDeploySquadInput,
  type RunDeploySquadOutput,
} from '@blackshop/landinglab-deploy';
import { createVercelDomainsClient } from '@blackshop/landinglab-domains';
import type { Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';

import { logger } from '../logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Job payload emitted by the backoffice server action `publishLandingPage`
 * (apps/backoffice/src/app/(dashboard)/landing-pages/[id]/publish-actions.ts).
 * Validated at runtime via DeployJobPayloadSchema.
 */
export interface LandingLabDeployJobData {
  landingPageId: string;
  deploymentId: string;
  deploymentType: 'subdomain' | 'custom_domain';
  hostname: string;
  customDomain?: string;
}

// Injectable factory for tests.
export interface LandingLabDeployDeps {
  runDeploySquad: (
    input: RunDeploySquadInput,
    deps: DeploySquadDeps,
  ) => Promise<RunDeploySquadOutput>;
  buildDeploySquadDeps: () => DeploySquadDeps;
  createDbClient?: () => ReturnType<typeof createClient>;
}

// ─── Production deps ─────────────────────────────────────────────────────

export function createProductionDeps(): LandingLabDeployDeps {
  return {
    runDeploySquad,
    buildDeploySquadDeps: (): DeploySquadDeps => {
      const { db } = createClient({
        databaseUrl:
          process.env['DATABASE_URL'] ??
          'postgresql://blackshop:changeme@localhost:5432/blackshop',
      });
      // Env presence is checked lazily inside each provider on first call
      // (requireApiKey pattern). Worker bootstrap must NOT crash when
      // LANDINGLAB_SPACESHIP_API_KEY or LANDINGLAB_VERCEL_TOKEN are missing
      // — dev/CI paths that only exercise subdomain never touch Spaceship.
      return {
        db,
        spaceship: createSpaceshipClient(),
        vercel: createVercelDomainsClient(),
        vercelProjectId: process.env['LANDINGLAB_VERCEL_PROJECT_ID'],
        vercelToken: process.env['LANDINGLAB_VERCEL_TOKEN'],
      };
    },
  };
}

// ─── Processor factory ───────────────────────────────────────────────────

/**
 * BullMQ processor factory. Deps injectable for unit tests.
 * Prod: `makeLandingLabDeployProcessor(createProductionDeps())`.
 */
export function makeLandingLabDeployProcessor(
  deps: LandingLabDeployDeps = createProductionDeps(),
): (job: Job<LandingLabDeployJobData>) => Promise<{
  ok: boolean;
  runId: string;
  deploymentId: string;
  hostname: string;
  deploymentStatus: 'published' | 'awaiting_ssl' | 'publish_failed';
  publishedUrl?: string;
  costUsd: number;
  durationMs: number;
  error?: string;
}> {
  return async function landingLabDeployProcessor(job) {
    const started = Date.now();

    // ─── Step 0: Validate payload (Zod — throws before DB write) ──────
    // Any invalid payload fails BullMQ retry logic immediately. Payloads
    // come from the backoffice server action so shape should always be
    // valid — but defense in depth costs nothing here.
    const payload = validateDeployJobPayload(job.data);
    const { landingPageId, deploymentId, deploymentType, hostname, customDomain } = payload;

    logger.info(
      { jobId: job.id, landingPageId, deploymentId, deploymentType, hostname, customDomain },
      'landinglab.squad5.deploy job started',
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
      // ─── Step 1: Insert run row (status='running') ──────────────────
      const [inserted] = await db
        .insert(landingGenerationRuns)
        .values({
          landingPageId,
          squad: 'deploy',
          status: 'running',
          input: {
            deploymentId,
            deploymentType,
            hostname,
            customDomain: customDomain ?? null,
          } as unknown as Record<string, unknown>,
          startedAt: new Date(),
        })
        .returning({ id: landingGenerationRuns.id });
      if (!inserted) throw new Error('failed to insert landing_generation_runs row');
      runId = inserted.id;

      // ─── Step 2: Call orchestrator ────────────────────────────────────
      const squadDeps = deps.buildDeploySquadDeps();
      const input: RunDeploySquadInput = {
        landingPageId,
        deploymentId,
        deploymentType,
        hostname,
        ...(customDomain ? { customDomain } : {}),
      };

      const result = await deps.runDeploySquad(input, squadDeps);

      // ─── Step 3: Persist run outcome per deploymentStatus ─────────────
      if (result.ok) {
        // Two happy-end states: published (fully live) OR awaiting_ssl
        // (custom_domain waiting for Let's Encrypt — operator retries via UI).
        // Both mark the run as 'completed' — orchestrator already updated
        // landing_deployments + landing_pages appropriately.
        await db
          .update(landingGenerationRuns)
          .set({
            status: 'completed',
            completedAt: new Date(),
            costUsd: String(result.costUsd.toFixed(4)),
            durationMs: Date.now() - started,
            agentTrace: result.agentTrace as unknown as Record<string, unknown>,
            output: {
              deploymentId: result.deploymentId,
              hostname: result.hostname,
              publishedUrl: result.publishedUrl,
              deploymentStatus: result.deploymentStatus,
            } as unknown as Record<string, unknown>,
          })
          .where(eq(landingGenerationRuns.id, runId));

        if (result.deploymentStatus === 'awaiting_ssl') {
          logger.info(
            {
              jobId: job.id,
              runId,
              landingPageId,
              deploymentId,
              hostname: result.hostname,
              costUsd: result.costUsd,
              durationMs: Date.now() - started,
            },
            'landinglab.squad5.deploy job completed — SSL pending, operator will retry via backoffice',
          );
        } else {
          logger.info(
            {
              jobId: job.id,
              runId,
              landingPageId,
              deploymentId,
              hostname: result.hostname,
              publishedUrl: result.publishedUrl,
              costUsd: result.costUsd,
              durationMs: Date.now() - started,
            },
            'landinglab.squad5.deploy job completed — landing published (PIPELINE END-TO-END COMPLETE)',
          );
        }

        // Terminal squad — NO downstream enqueue. LandingLab pipeline
        // ends here. Squad 5 is the final squad in Epic 13.
        return {
          ok: true,
          runId,
          deploymentId: result.deploymentId,
          hostname: result.hostname,
          deploymentStatus: result.deploymentStatus,
          publishedUrl: result.publishedUrl,
          costUsd: result.costUsd,
          durationMs: Date.now() - started,
        };
      }

      // ─── Step 4: Orchestrator returned publish_failed ─────────────────
      // Semantic rollback: cost_usd preserved (Spaceship purchases aren't
      // reversible), agent_trace preserved for audit + retry guidance in UI.
      // The orchestrator already updated landing_deployments row status to
      // 'publish_failed' with error_agent + error_reason in metadata.
      const failureError = result.error;
      await db
        .update(landingGenerationRuns)
        .set({
          status: 'failed',
          completedAt: new Date(),
          costUsd: String(result.costUsd.toFixed(4)),
          durationMs: Date.now() - started,
          agentTrace: result.agentTrace as unknown as Record<string, unknown>,
          error: failureError,
          output: {
            deploymentId: result.deploymentId,
            hostname: result.hostname,
            errorAgent: result.errorAgent,
          } as unknown as Record<string, unknown>,
        })
        .where(eq(landingGenerationRuns.id, runId));

      logger.warn(
        {
          jobId: job.id,
          runId,
          landingPageId,
          deploymentId: result.deploymentId,
          hostname: result.hostname,
          errorAgent: result.errorAgent,
          error: failureError,
          costUsd: result.costUsd,
          durationMs: Date.now() - started,
        },
        'landinglab.squad5.deploy job completed with publish_failed — operator can retry via backoffice',
      );

      // Return typed failure — do NOT rethrow. BullMQ retries would spawn
      // duplicate DNS records / duplicate domain purchases. Failure is a
      // valid terminal state visible in the backoffice.
      return {
        ok: false,
        runId,
        deploymentId: result.deploymentId,
        hostname: result.hostname,
        deploymentStatus: 'publish_failed',
        costUsd: result.costUsd,
        durationMs: Date.now() - started,
        error: failureError,
      };
    } catch (err) {
      // Uncaught error path (schema validation, DB unreachable, orchestrator
      // exception before any state persisted). Mark run failed + rethrow so
      // BullMQ retry policy kicks in for transient issues.
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, jobId: job.id, runId, landingPageId, deploymentId },
        'landinglab.squad5.deploy job failed with uncaught error',
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
            'failed to mark deploy run as failed (double failure)',
          );
        }
      }
      // Safety net: se o orquestrador crashou antes de finalizar a
      // landing_deployments row, garante que ela não fique presa em
      // 'queued' ou 'provisioning' indefinidamente. Só transiciona se
      // ainda estiver em estado transitório (não sobrescreve 'published'
      // ou 'awaiting_ssl' já corretamente persistido).
      if (deploymentId) {
        try {
          await db
            .update(landingDeployments)
            .set({
              deploymentStatus: 'publish_failed',
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(landingDeployments.id, deploymentId),
                inArray(landingDeployments.deploymentStatus, [
                  'queued',
                  'provisioning',
                ]),
              ),
            );
        } catch (deploymentUpdateErr) {
          logger.error(
            { err: deploymentUpdateErr, deploymentId },
            'failed to mark landing_deployments as publish_failed (safety net)',
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

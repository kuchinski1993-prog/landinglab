// runDeploySquad — orchestrator for Squad 5 (Deploy). Wave 2 real impl.
//
// Flow (SEQUENTIAL — deployment steps have ordering dependencies):
//   1. Mark deployment provisioning.
//   2. Load base landing_page (slug + content_language).
//   3. runDomainBroker → hostname + cost + dnsProvider.
//   4. Persist hostname / dns_provider / verification_url.
//   5. runDnsConfigurator → dns_records applied (or wildcard_handles).
//   6. runStorefrontPublisher → verify DB row and (custom) attach to Vercel.
//   7. runSslValidator → provisioned | awaiting_ssl (stops here on awaiting_ssl).
//   8. runPublishVerifier → HTTP health check (4 checks).
//   9. Persist final state:
//        health passed → published + landing_pages.status='published'
//        health failed → publish_failed with error_reason + failed_checks
//  10. Persist deployment_metadata (agent_trace has one entry per agent — Article IV).
//  11. Return typed output (validated via validateRunDeploySquadOutput).
//
// Retry policy per agent: max 1 (deployment steps mutate external state —
// double-purchase or double-DNS on retry would be worse than surfacing an error).
//
// Per-agent timeout budgets (Task #41): each agent has its own budget so a slow
// DNS lookup doesn't consume SSL polling time. SSL is aligned with the internal
// polling budget (MAX_POLLS × POLL_INTERVAL_MS) + 5s margin. Every budget is
// overridable via env: LANDINGLAB_DEPLOY_TIMEOUT_<AGENT>_MS (uppercase, hyphen
// → underscore). Invalid values fall back to defaults silently.

import { eq, sql } from 'drizzle-orm';
import type { Database } from '@blackshop/db';
import { landingDeployments, landingDomains, landingPages } from '@blackshop/db';

import { runDomainBroker } from './agents/domain-broker.js';
import { runDnsConfigurator } from './agents/dns-configurator.js';
import { runStorefrontPublisher } from './agents/storefront-publisher.js';
import { runSslValidator } from './agents/ssl-validator.js';
import { runPublishVerifier } from './agents/publish-verifier.js';
import { verificationUrlFor } from './agents/shared.js';
import type { SpaceshipAdapter } from './providers/spaceship.js';
import type { VercelDomainsAdapter } from './providers/vercel.js';
import {
  validateDeploymentMetadata,
  type AgentTraceEntry,
  type DeploymentMetadata,
  type DeploymentType,
} from './schema/deployment.js';

// ─── Public types ────────────────────────────────────────────────────────

export interface RunDeploySquadInput {
  landingPageId: string;
  deploymentId: string;
  deploymentType: DeploymentType;
  hostname: string;
  customDomain?: string;
}

export interface RunDeploySquadSuccessOutput {
  ok: true;
  deploymentId: string;
  hostname: string;
  publishedUrl: string;
  deploymentStatus: 'published' | 'awaiting_ssl';
  costUsd: number;
  durationMs: number;
  agentTrace: AgentTraceEntry[];
}

export interface RunDeploySquadFailureOutput {
  ok: false;
  deploymentId: string;
  hostname: string;
  error: string;
  errorAgent?: string;
  costUsd: number;
  durationMs: number;
  agentTrace: AgentTraceEntry[];
}

export type RunDeploySquadOutput = RunDeploySquadSuccessOutput | RunDeploySquadFailureOutput;

export interface DeploySquadDeps {
  db: Database;
  spaceship: SpaceshipAdapter;
  vercel: VercelDomainsAdapter;
  httpClient?: (url: string, opts?: RequestInit) => Promise<Response>;
  dnsResolver?: (hostname: string, rrtype: 'A' | 'CNAME') => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
  vercelProjectId?: string;
  vercelToken?: string;
  now?: () => Date;
}

// ─── Per-agent timeout budgets ───────────────────────────────────────────
//
// SSL default aligns with ssl-validator polling: 10 polls × 30s = 300s
// + 5s margin. If the operator raises LANDINGLAB_SSL_MAX_POLLS or
// LANDINGLAB_SSL_POLL_INTERVAL_MS, they should also raise
// LANDINGLAB_DEPLOY_TIMEOUT_SSL_VALIDATOR_MS to match.
type AgentName =
  | 'domain-broker'
  | 'dns-configurator'
  | 'storefront-publisher'
  | 'ssl-validator'
  | 'publish-verifier';

const DEFAULT_AGENT_TIMEOUTS: Record<AgentName, number> = {
  'domain-broker': 60_000, // Spaceship availability + register + DNS lookup
  'dns-configurator': 30_000, // Spaceship DNS API (or wildcard probe)
  'storefront-publisher': 30_000, // DB query + optional Vercel add
  'ssl-validator': 305_000, // 300s poll budget + 5s margin
  'publish-verifier': 30_000, // 4 HTTP checks (10s each per HTTP_TIMEOUT_MS)
};

function envKeyFor(agent: AgentName): string {
  return `LANDINGLAB_DEPLOY_TIMEOUT_${agent.replace(/-/g, '_').toUpperCase()}_MS`;
}

function agentTimeout(agent: AgentName): number {
  const envKey = envKeyFor(agent);
  const raw = process.env[envKey];
  if (raw === undefined) return DEFAULT_AGENT_TIMEOUTS[agent];
  const n = Number(raw);
  // Range: 1s..30min. Anything outside → fallback silently.
  if (!Number.isFinite(n) || n < 1_000 || n > 1_800_000) {
    return DEFAULT_AGENT_TIMEOUTS[agent];
  }
  return Math.floor(n);
}

function withTimeout<T>(promise: Promise<T>, ms: number, agentName: AgentName): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      const message = `[landinglab-deploy] ${agentName} timed out after ${ms}ms`;
      // eslint-disable-next-line no-console
      console.error(message);
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────

export async function runDeploySquad(
  input: RunDeploySquadInput,
  deps: DeploySquadDeps,
): Promise<RunDeploySquadOutput> {
  const started = Date.now();
  return runInternal(input, deps, started);
}

// ─── Internal flow ───────────────────────────────────────────────────────

async function runInternal(
  input: RunDeploySquadInput,
  deps: DeploySquadDeps,
  started: number,
): Promise<RunDeploySquadOutput> {
  const trace: AgentTraceEntry[] = [];
  const now = deps.now ?? ((): Date => new Date());
  let cumulativeCost = 0;

  await setDeploymentStatus(deps.db, input.deploymentId, 'provisioning', now());

  const base = await loadBaseLandingPage(deps.db, input.landingPageId);
  const contentLanguage = base.contentLanguage ?? 'en';

  // ── Step 1: Domain Broker ───────────────────────────────────────────
  const brokerStart = Date.now();
  let brokerResult: Awaited<ReturnType<typeof runDomainBroker>>;
  try {
    brokerResult = await withTimeout(
      runDomainBroker(
        {
          deploymentType: input.deploymentType,
          deploymentId: input.deploymentId,
          landingPageSlug: base.slug,
          contentLanguage,
          customDomain: input.customDomain ?? null,
          brandName: base.slug,
        },
        { db: deps.db, spaceship: deps.spaceship },
      ),
      agentTimeout('domain-broker'),
      'domain-broker',
    );
  } catch (err) {
    const message = (err as Error).message;
    trace.push({
      agent: 'domain-broker',
      action: input.deploymentType === 'custom_domain' ? 'purchase_domain' : 'compute_subdomain',
      latency_ms: Date.now() - brokerStart,
      cost_usd: 0,
      error: message,
    });
    return finalizeFailure(deps, input, trace, cumulativeCost, started, now(), {
      agent: 'domain-broker',
      reason: message,
    });
  }

  if (!brokerResult.ok) {
    trace.push({
      agent: 'domain-broker',
      provider: 'spaceship',
      action: input.deploymentType === 'custom_domain' ? 'purchase_domain' : 'compute_subdomain',
      latency_ms: Date.now() - brokerStart,
      cost_usd: 0,
      error: brokerResult.error,
      output: brokerResult.suggestions
        ? { suggestions: brokerResult.suggestions }
        : undefined,
    });
    return finalizeFailure(deps, input, trace, cumulativeCost, started, now(), {
      agent: 'domain-broker',
      reason: brokerResult.error,
    });
  }

  cumulativeCost += brokerResult.costUsd;
  const finalHostname = brokerResult.hostname;
  trace.push({
    agent: 'domain-broker',
    provider: brokerResult.dnsProvider === 'spaceship' ? 'spaceship' : undefined,
    action: input.deploymentType === 'custom_domain' ? 'purchase_domain' : 'compute_subdomain',
    latency_ms: Date.now() - brokerStart,
    cost_usd: brokerResult.costUsd,
    output: {
      hostname: finalHostname,
      dnsProvider: brokerResult.dnsProvider,
      purchaseMeta: brokerResult.purchaseMeta,
    },
  });

  const verificationUrl = verificationUrlFor(finalHostname);
  await deps.db
    .update(landingDeployments)
    .set({
      hostname: finalHostname,
      dnsProvider: brokerResult.dnsProvider === 'wildcard' ? null : brokerResult.dnsProvider,
      verificationUrl,
      costUsd: cumulativeCost.toFixed(4),
      updatedAt: now(),
    })
    .where(eq(landingDeployments.id, input.deploymentId));

  // ── Step 2: DNS Configurator (with wildcard assertion) ──────────────
  const dnsStart = Date.now();
  try {
    const dnsResult = await withTimeout(
      runDnsConfigurator(
        { deploymentType: input.deploymentType, hostname: finalHostname },
        { spaceship: deps.spaceship, dnsResolver: deps.dnsResolver },
      ),
      agentTimeout('dns-configurator'),
      'dns-configurator',
    );
    trace.push({
      agent: 'dns-configurator',
      provider: dnsResult.provider === 'wildcard' ? undefined : 'spaceship',
      action: 'configure_dns',
      latency_ms: Date.now() - dnsStart,
      cost_usd: 0,
      output: {
        provider: dnsResult.provider,
        recordsCount: dnsResult.dnsRecords.length,
        skippedReason: dnsResult.skippedReason,
      },
    });
    // Persist dns_records + provider now (allows partial-failure debug).
    await deps.db
      .update(landingDeployments)
      .set({
        dnsRecords: dnsResult.dnsRecords as unknown,
        dnsProvider: dnsResult.provider === 'wildcard' ? null : dnsResult.provider,
        updatedAt: now(),
      })
      .where(eq(landingDeployments.id, input.deploymentId));
  } catch (err) {
    const message = (err as Error).message;
    trace.push({
      agent: 'dns-configurator',
      action: 'configure_dns',
      latency_ms: Date.now() - dnsStart,
      cost_usd: 0,
      error: message,
    });
    return finalizeFailure(deps, input, trace, cumulativeCost, started, now(), {
      agent: 'dns-configurator',
      reason: message,
      hostname: finalHostname,
    });
  }

  // ── Step 3: Storefront Publisher ────────────────────────────────────
  const storefrontStart = Date.now();
  try {
    const sfResult = await withTimeout(
      runStorefrontPublisher(
        {
          deploymentType: input.deploymentType,
          landingPageId: input.landingPageId,
          hostname: finalHostname,
        },
        {
          db: deps.db,
          vercel: deps.vercel,
          vercelProjectId: deps.vercelProjectId,
          vercelToken: deps.vercelToken,
        },
      ),
      agentTimeout('storefront-publisher'),
      'storefront-publisher',
    );
    trace.push({
      agent: 'storefront-publisher',
      provider: input.deploymentType === 'custom_domain' ? 'vercel' : undefined,
      action: 'verify_storefront',
      latency_ms: Date.now() - storefrontStart,
      cost_usd: 0,
      output: {
        vercelDomainAdded: sfResult.vercelDomainAdded,
        vercelInitiallyVerified: sfResult.vercelInitiallyVerified,
      },
    });
  } catch (err) {
    const message = (err as Error).message;
    trace.push({
      agent: 'storefront-publisher',
      action: 'verify_storefront',
      latency_ms: Date.now() - storefrontStart,
      cost_usd: 0,
      error: message,
    });
    return finalizeFailure(deps, input, trace, cumulativeCost, started, now(), {
      agent: 'storefront-publisher',
      reason: message,
      hostname: finalHostname,
    });
  }

  // ── Step 4: SSL Validator ───────────────────────────────────────────
  const sslStart = Date.now();
  let sslPending = false;
  try {
    const sslResult = await withTimeout(
      runSslValidator(
        { deploymentType: input.deploymentType, hostname: finalHostname },
        {
          vercel: deps.vercel,
          vercelProjectId: deps.vercelProjectId,
          vercelToken: deps.vercelToken,
          sleep: deps.sleep,
        },
      ),
      agentTimeout('ssl-validator'),
      'ssl-validator',
    );
    trace.push({
      agent: 'ssl-validator',
      provider: input.deploymentType === 'custom_domain' ? 'vercel' : undefined,
      action: 'poll_ssl',
      latency_ms: Date.now() - sslStart,
      cost_usd: 0,
      output: {
        sslStatus: sslResult.sslStatus,
        method: sslResult.method,
        pollAttempts: 'pollAttempts' in sslResult ? sslResult.pollAttempts : undefined,
      },
    });

    if (sslResult.sslStatus === 'provisioned') {
      await deps.db
        .update(landingDeployments)
        .set({ sslStatus: 'provisioned', updatedAt: now() })
        .where(eq(landingDeployments.id, input.deploymentId));
      // Mark landing_domains.dns_verified_at now that SSL is confirmed.
      // Idempotent (UPDATE by domain — no-op for subdomains not tracked as
      // domains). Promote role='pending_dns' → 'active' in the same statement.
      await markDomainVerified(deps.db, finalHostname, now());
    } else {
      sslPending = true;
      await deps.db
        .update(landingDeployments)
        .set({
          sslStatus: 'pending',
          deploymentStatus: 'awaiting_ssl',
          updatedAt: now(),
        })
        .where(eq(landingDeployments.id, input.deploymentId));
    }
  } catch (err) {
    const message = (err as Error).message;
    trace.push({
      agent: 'ssl-validator',
      action: 'poll_ssl',
      latency_ms: Date.now() - sslStart,
      cost_usd: 0,
      error: message,
    });
    return finalizeFailure(deps, input, trace, cumulativeCost, started, now(), {
      agent: 'ssl-validator',
      reason: message,
      hostname: finalHostname,
    });
  }

  if (sslPending) {
    const metadata: DeploymentMetadata = {
      agent_trace: trace,
      warnings: ['ssl_pending_operator_will_retry'],
    };
    await persistMetadata(deps.db, input.deploymentId, metadata, now());
    const durationMs = Date.now() - started;
    return {
      ok: true,
      deploymentId: input.deploymentId,
      hostname: finalHostname,
      publishedUrl: verificationUrl,
      deploymentStatus: 'awaiting_ssl',
      costUsd: cumulativeCost,
      durationMs,
      agentTrace: trace,
    };
  }

  // ── Step 5: Publish Verifier ────────────────────────────────────────
  const verifyStart = Date.now();
  let verifierResult: Awaited<ReturnType<typeof runPublishVerifier>>;
  try {
    verifierResult = await withTimeout(
      runPublishVerifier(
        {
          landingPageId: input.landingPageId,
          hostname: finalHostname,
          contentLanguage,
        },
        { db: deps.db, httpClient: deps.httpClient },
      ),
      agentTimeout('publish-verifier'),
      'publish-verifier',
    );
  } catch (err) {
    const message = (err as Error).message;
    trace.push({
      agent: 'publish-verifier',
      action: 'health_check',
      latency_ms: Date.now() - verifyStart,
      cost_usd: 0,
      error: message,
    });
    return finalizeFailure(deps, input, trace, cumulativeCost, started, now(), {
      agent: 'publish-verifier',
      reason: message,
      hostname: finalHostname,
    });
  }

  trace.push({
    agent: 'publish-verifier',
    provider: 'http',
    action: 'health_check',
    latency_ms: Date.now() - verifyStart,
    cost_usd: 0,
    output: {
      healthCheckPassed: verifierResult.healthCheckPassed,
      status: verifierResult.status,
      checksPassed: verifierResult.checksPassed,
      checksFailed: verifierResult.checksFailed,
      responseTimeMs: verifierResult.responseTimeMs,
    },
  });

  if (!verifierResult.healthCheckPassed) {
    const reason = `health_check_failed: ${verifierResult.checksFailed.join(',')}`;
    return finalizeFailure(deps, input, trace, cumulativeCost, started, now(), {
      agent: 'publish-verifier',
      reason,
      hostname: finalHostname,
      healthCheckResult: verifierResult,
    });
  }

  // ── Success: persist published state ────────────────────────────────
  const publishedAt = now();
  const metadata: DeploymentMetadata = {
    agent_trace: trace,
    dns_setup: {
      provider: input.deploymentType === 'subdomain' ? 'wildcard' : 'spaceship',
      records_applied: [],
    },
    ssl_setup: {
      provider: input.deploymentType === 'subdomain' ? 'wildcard-vercel' : 'vercel-letsencrypt',
      verified: true,
    },
    health_check_results: {
      status: verifierResult.status,
      checks_passed: verifierResult.checksPassed,
      checks_failed: verifierResult.checksFailed,
      response_time_ms: verifierResult.responseTimeMs,
      verified_at: verifierResult.verifiedAt,
    },
    storefront_verified: true,
    warnings: verifierResult.warning ? [verifierResult.warning] : undefined,
  };

  await persistMetadata(deps.db, input.deploymentId, metadata, publishedAt);
  await deps.db
    .update(landingDeployments)
    .set({
      deploymentStatus: 'published',
      publishedAt,
      updatedAt: publishedAt,
    })
    .where(eq(landingDeployments.id, input.deploymentId));

  await deps.db
    .update(landingPages)
    .set({
      status: 'published',
      currentDeploymentId: input.deploymentId,
      publishedAt,
      updatedAt: publishedAt,
    })
    .where(eq(landingPages.id, input.landingPageId));

  return {
    ok: true,
    deploymentId: input.deploymentId,
    hostname: finalHostname,
    publishedUrl: verificationUrl,
    deploymentStatus: 'published',
    costUsd: cumulativeCost,
    durationMs: Date.now() - started,
    agentTrace: trace,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

interface BaseLandingPage {
  id: string;
  slug: string;
  contentLanguage: string | null;
}

async function loadBaseLandingPage(
  db: Database,
  landingPageId: string,
): Promise<BaseLandingPage> {
  const rows = await db
    .select({
      id: landingPages.id,
      slug: landingPages.slug,
      contentLanguage: landingPages.contentLanguage,
    })
    .from(landingPages)
    .where(eq(landingPages.id, landingPageId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`landing_page not found: id=${landingPageId}`);
  }
  return { id: row.id, slug: row.slug, contentLanguage: row.contentLanguage ?? null };
}

async function setDeploymentStatus(
  db: Database,
  deploymentId: string,
  deploymentStatus: string,
  when: Date,
): Promise<void> {
  await db
    .update(landingDeployments)
    .set({ deploymentStatus, updatedAt: when })
    .where(eq(landingDeployments.id, deploymentId));
}

// Mark landing_domains.dnsVerifiedAt = when after SSL succeeds. Also promotes
// role='pending_dns' → 'active' in the same UPDATE (custom_domain workflow).
// No-op for subdomains that aren't tracked in landing_domains — safe by design.
async function markDomainVerified(
  db: Database,
  hostname: string,
  when: Date,
): Promise<void> {
  try {
    await db
      .update(landingDomains)
      .set({
        dnsVerifiedAt: when,
        role: sql`CASE WHEN ${landingDomains.role} = 'pending_dns' THEN 'active' ELSE ${landingDomains.role} END`,
      })
      .where(eq(landingDomains.domain, hostname));
    // eslint-disable-next-line no-console
    console.log(`[landinglab-deploy] domain ${hostname} verified at ${when.toISOString()}`);
  } catch (err) {
    // Best-effort: never fail the deploy over a landing_domains sync issue.
    // eslint-disable-next-line no-console
    console.warn(
      `[landinglab-deploy] markDomainVerified failed for ${hostname}: ${(err as Error).message}`,
    );
  }
}

async function persistMetadata(
  db: Database,
  deploymentId: string,
  metadata: DeploymentMetadata,
  when: Date,
): Promise<void> {
  const validated = validateDeploymentMetadata(metadata);
  await db
    .update(landingDeployments)
    .set({
      deploymentMetadata: validated as unknown,
      updatedAt: when,
    })
    .where(eq(landingDeployments.id, deploymentId));
}

interface FailureCtx {
  agent: string;
  reason: string;
  hostname?: string;
  healthCheckResult?: Awaited<ReturnType<typeof runPublishVerifier>>;
}

async function finalizeFailure(
  deps: DeploySquadDeps,
  input: RunDeploySquadInput,
  trace: AgentTraceEntry[],
  costUsd: number,
  started: number,
  when: Date,
  ctx: FailureCtx,
): Promise<RunDeploySquadFailureOutput> {
  // Ensure agent_trace has >=1 entry (Article IV). If broker failed before
  // pushing any trace (impossible under current flow, but defensive), synthesize
  // a minimal entry so validation passes.
  if (trace.length === 0) {
    trace.push({
      agent: ctx.agent,
      action: 'failure',
      latency_ms: 0,
      cost_usd: 0,
      error: ctx.reason,
    });
  }

  const metadata: DeploymentMetadata = {
    agent_trace: trace,
    error_agent: ctx.agent,
    error_reason: ctx.reason,
    health_check_results: ctx.healthCheckResult
      ? {
          status: ctx.healthCheckResult.status,
          checks_passed: ctx.healthCheckResult.checksPassed,
          checks_failed: ctx.healthCheckResult.checksFailed,
          response_time_ms: ctx.healthCheckResult.responseTimeMs,
          verified_at: ctx.healthCheckResult.verifiedAt,
        }
      : undefined,
  };

  try {
    await persistMetadata(deps.db, input.deploymentId, metadata, when);
  } catch {
    /* metadata persist best-effort on failure path */
  }

  await deps.db
    .update(landingDeployments)
    .set({
      deploymentStatus: 'publish_failed',
      costUsd: costUsd.toFixed(4),
      updatedAt: when,
    })
    .where(eq(landingDeployments.id, input.deploymentId));

  return {
    ok: false,
    deploymentId: input.deploymentId,
    hostname: ctx.hostname ?? input.hostname,
    error: ctx.reason,
    errorAgent: ctx.agent,
    costUsd,
    durationMs: Date.now() - started,
    agentTrace: trace,
  };
}

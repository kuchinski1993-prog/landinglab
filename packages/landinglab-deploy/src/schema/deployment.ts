// Deployment schemas — Zod (Story 13.8 — Squad 5, AC18).
//
// Validates every artifact produced by the Deploy Squad orchestrator:
//   - DeployJobPayloadSchema   → validates BullMQ job.data at processor entry (AC21)
//   - DnsRecordSchema          → validates each DNS record persisted in landing_deployments.dns_records
//   - AgentTraceEntrySchema    → one entry per agent execution (Article IV audit trail)
//   - DeploymentMetadataSchema → persisted in landing_deployments.deployment_metadata (jsonb)
//   - RunDeploySquadOutputSchema → validates orchestrator return shape
//
// Article IV (No Invention) enforcement:
//   1. `agent_trace` min 1 entry → orchestrator MUST persist trace of every
//      agent that ran (Deploy Chief + 5 specialists). Empty trace = no audit
//      = violation. Enforced at Zod runtime via validateDeploymentMetadata().
//   2. Deployment type / SSL status / deployment status are strict enums →
//      matches DB CHECK constraints (packages/db/migrations/0051_landinglab_deploy.sql).
//   3. Hostname min 3 chars → catches obviously-invalid inputs at boundary.
//
// Reference pattern: packages/landinglab-build/src/schema/build-output.ts.

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Enums — MUST mirror packages/db/src/schema-landinglab.ts constants
// ─────────────────────────────────────────────────────────────────────────

export const DeploymentTypeSchema = z.enum(['subdomain', 'custom_domain']);
export type DeploymentType = z.infer<typeof DeploymentTypeSchema>;

export const SslStatusSchema = z.enum(['pending', 'provisioned', 'failed']);
export type SslStatus = z.infer<typeof SslStatusSchema>;

export const DeploymentStatusSchema = z.enum([
  'queued',
  'provisioning',
  'awaiting_ssl',
  'published',
  'publish_failed',
  'unpublished',
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

// ─────────────────────────────────────────────────────────────────────────
// DnsRecord — one record entry (subset of RFC-1035 types actually needed)
// ─────────────────────────────────────────────────────────────────────────

export const DnsRecordSchema = z
  .object({
    type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX']),
    name: z.string().min(1, 'DNS record `name` cannot be empty'),
    value: z.string().min(1, 'DNS record `value` cannot be empty'),
    ttl: z.number().int().min(60).max(86_400).optional(),
    // MX only — 0-65535 per RFC.
    priority: z.number().int().min(0).max(65_535).optional(),
  })
  .strict();
export type DnsRecord = z.infer<typeof DnsRecordSchema>;

// ─────────────────────────────────────────────────────────────────────────
// AgentTraceEntry — one entry per agent execution.
// Article IV: agent + action + latency + cost REQUIRED; output optional.
// ─────────────────────────────────────────────────────────────────────────

export const AgentTraceEntrySchema = z
  .object({
    agent: z.string().min(1, 'agent name required'),
    // 'spaceship' | 'vercel' | 'http' — external service used, if any.
    provider: z.string().min(1).optional(),
    // Human-readable verb: 'check_availability', 'purchase_domain',
    // 'attach_domain', 'poll_verification', 'health_check', etc.
    action: z.string().min(1, 'action verb required'),
    latency_ms: z.number().int().min(0),
    // 0 for deterministic agents; > 0 only when Spaceship purchase happened.
    cost_usd: z.number().min(0),
    // Serialized subset of the agent output (do NOT store secrets).
    output: z.unknown().optional(),
    // Populated only on failure — kept alongside successful trace for post-mortem.
    error: z.string().optional(),
  })
  .strict();
export type AgentTraceEntry = z.infer<typeof AgentTraceEntrySchema>;

// ─────────────────────────────────────────────────────────────────────────
// DnsSetup / SslSetup / HealthCheckResult — nested artifacts
// ─────────────────────────────────────────────────────────────────────────

export const DnsSetupSchema = z
  .object({
    // 'spaceship' | 'vercel' | 'wildcard' — provider that actually applied records.
    provider: z.string().min(1),
    records_applied: z.array(DnsRecordSchema),
    // Propagation warning surfaced by dns-configurator (non-fatal).
    warning: z.string().optional(),
  })
  .strict();
export type DnsSetup = z.infer<typeof DnsSetupSchema>;

export const SslSetupSchema = z
  .object({
    provider: z.enum(['vercel-letsencrypt', 'wildcard-vercel']),
    verified: z.boolean(),
    // Set when ssl still pending after polling timeout (awaiting_ssl state).
    reason: z.string().optional(),
    poll_attempts: z.number().int().min(0).optional(),
  })
  .strict();
export type SslSetup = z.infer<typeof SslSetupSchema>;

export const HealthCheckResultSchema = z
  .object({
    // 200 = green; 4xx/5xx = failed. Populated even on timeout (-1 sentinel).
    status: z.number().int(),
    checks_passed: z.array(z.string()),
    checks_failed: z.array(z.string()),
    response_time_ms: z.number().int().min(0),
    verified_at: z.string().datetime(),
  })
  .strict();
export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

// ─────────────────────────────────────────────────────────────────────────
// DeploymentMetadata — persisted in landing_deployments.deployment_metadata
//
// Article IV: agent_trace MIN 1 → orchestrator MUST persist audit trail.
// ─────────────────────────────────────────────────────────────────────────

export const DeploymentMetadataSchema = z
  .object({
    // ─── Article IV audit trail (mandatory) ──────────────────────────
    agent_trace: z
      .array(AgentTraceEntrySchema)
      .min(1, 'agent_trace must have >= 1 entry (Article IV audit trail)'),
    // ─── DNS / SSL / Health (populated by respective agents; optional
    // during early failure paths where an agent never ran) ────────────
    dns_setup: DnsSetupSchema.optional(),
    ssl_setup: SslSetupSchema.optional(),
    health_check_results: HealthCheckResultSchema.optional(),
    // ─── Storefront verification flag (set by storefront-publisher) ──
    storefront_verified: z.boolean().optional(),
    // ─── Failure fields (populated only when deployment_status='publish_failed') ─
    error_agent: z.string().optional(),
    error_reason: z.string().optional(),
    // ─── Non-fatal warnings surfaced by any agent ────────────────────
    warnings: z.array(z.string()).optional(),
  })
  .strict();
export type DeploymentMetadata = z.infer<typeof DeploymentMetadataSchema>;

// ─────────────────────────────────────────────────────────────────────────
// DeployJobPayload — validates BullMQ job.data at processor entry (AC21)
// ─────────────────────────────────────────────────────────────────────────

export const DeployJobPayloadSchema = z
  .object({
    landingPageId: z.string().uuid('landingPageId must be a UUID'),
    deploymentId: z.string().uuid('deploymentId must be a UUID'),
    deploymentType: DeploymentTypeSchema,
    // Hostname pre-computed by publishLandingPage Server Action (AC7).
    // For subdomain: '{slug}.landinglab.app'; for custom_domain: value of customDomain.
    hostname: z.string().min(3, 'hostname must be at least 3 characters'),
    // Only set when deploymentType='custom_domain'. Optional at schema level;
    // orchestrator enforces business rule (required for custom_domain path).
    customDomain: z.string().min(3).optional(),
  })
  .strict();
export type DeployJobPayload = z.infer<typeof DeployJobPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────
// RunDeploySquadOutput — orchestrator return shape (validated in Wave 2)
// ─────────────────────────────────────────────────────────────────────────

export const RunDeploySquadOutputSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      deploymentId: z.string().uuid(),
      hostname: z.string().min(3),
      publishedUrl: z.string().url(),
      costUsd: z.number().min(0),
      durationMs: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      deploymentId: z.string().uuid(),
      hostname: z.string().min(3),
      error: z.string().min(1),
      errorAgent: z.string().min(1).optional(),
      costUsd: z.number().min(0),
      durationMs: z.number().int().min(0),
    })
    .strict(),
]);
export type RunDeploySquadOutput = z.infer<typeof RunDeploySquadOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Runtime validators — throw with pretty error report on invalid data
// (mirrors packages/landinglab-build/src/schema/build-output.ts pattern).
// ─────────────────────────────────────────────────────────────────────────

export class DeploymentValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'DeploymentValidationError';
  }
}

function throwFromZod(prefix: string, err: z.ZodError): never {
  const pretty = err.issues
    .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('\n');
  throw new DeploymentValidationError(`${prefix}\n${pretty}`, err.issues);
}

export function validateDeployJobPayload(input: unknown): DeployJobPayload {
  const parsed = DeployJobPayloadSchema.safeParse(input);
  if (!parsed.success) {
    throwFromZod('Invalid DeployJobPayload:', parsed.error);
  }
  return parsed.data;
}

export function validateDeploymentMetadata(input: unknown): DeploymentMetadata {
  const parsed = DeploymentMetadataSchema.safeParse(input);
  if (!parsed.success) {
    throwFromZod('Invalid DeploymentMetadata (Article IV enforcement):', parsed.error);
  }
  return parsed.data;
}

export function validateRunDeploySquadOutput(input: unknown): RunDeploySquadOutput {
  const parsed = RunDeploySquadOutputSchema.safeParse(input);
  if (!parsed.success) {
    throwFromZod('Invalid RunDeploySquadOutput:', parsed.error);
  }
  return parsed.data;
}

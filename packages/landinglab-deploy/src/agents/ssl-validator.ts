// SSL Validator — Squad 5 Deploy Agent (AC16).
//
// Story 13.8 Wave 2.
//
// - subdomain: SSL inherited from Vercel wildcard cert → always provisioned.
// - custom_domain: poll Vercel Domains until ssl active. 10 polls × 30s = 5min.
//   If still pending after budget, return awaiting_ssl hint so the orchestrator
//   sets deployment_status='awaiting_ssl' (per @sm [AUTO-DECISION]).

import type { VercelDomainsAdapter } from '../providers/vercel.js';

export interface SslValidatorDeps {
  vercel: VercelDomainsAdapter;
  vercelProjectId?: string;
  vercelToken?: string;
  /** Injectable sleep — tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SslValidatorInput {
  deploymentType: 'subdomain' | 'custom_domain';
  hostname: string;
}

export type SslValidatorOutput =
  | { ok: true; sslStatus: 'provisioned'; method: 'wildcard' | 'letsencrypt'; pollAttempts?: number }
  | {
      ok: true;
      sslStatus: 'pending';
      method: 'letsencrypt';
      pollAttempts: number;
      deploymentStatusHint: 'awaiting_ssl';
    };

// Env-driven config (Task #37). Fallback silencioso pra defaults se inválido:
//   - LANDINGLAB_SSL_POLL_INTERVAL_MS: 5_000..300_000 (default 30_000)
//   - LANDINGLAB_SSL_MAX_POLLS:        1..60           (default 10)
function readIntervalMs(): number {
  const DEFAULT = 30_000;
  const raw = process.env.LANDINGLAB_SSL_POLL_INTERVAL_MS;
  if (raw === undefined) return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 5_000 || n > 300_000) return DEFAULT;
  return n;
}

function readMaxPolls(): number {
  const DEFAULT = 10;
  const raw = process.env.LANDINGLAB_SSL_MAX_POLLS;
  if (raw === undefined) return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 60) return DEFAULT;
  return Math.floor(n);
}

const POLL_INTERVAL_MS = readIntervalMs();
const MAX_POLLS = readMaxPolls();

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runSslValidator(
  input: SslValidatorInput,
  deps: SslValidatorDeps,
): Promise<SslValidatorOutput> {
  if (input.deploymentType === 'subdomain') {
    return { ok: true, sslStatus: 'provisioned', method: 'wildcard' };
  }

  const projectId = deps.vercelProjectId ?? process.env.LANDINGLAB_VERCEL_PROJECT_ID ?? '';
  const token = deps.vercelToken ?? process.env.LANDINGLAB_VERCEL_TOKEN ?? '';
  if (!projectId || !token) {
    throw new Error(
      'ssl_validator_config: LANDINGLAB_VERCEL_PROJECT_ID or LANDINGLAB_VERCEL_TOKEN not set',
    );
  }

  const sleep = deps.sleep ?? defaultSleep;
  let attempts = 0;
  while (attempts < MAX_POLLS) {
    attempts++;
    const status = await deps.vercel.getDomainStatus(input.hostname, projectId, token);
    if (status.verified) {
      return {
        ok: true,
        sslStatus: 'provisioned',
        method: 'letsencrypt',
        pollAttempts: attempts,
      };
    }
    if (attempts < MAX_POLLS) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  return {
    ok: true,
    sslStatus: 'pending',
    method: 'letsencrypt',
    pollAttempts: attempts,
    deploymentStatusHint: 'awaiting_ssl',
  };
}

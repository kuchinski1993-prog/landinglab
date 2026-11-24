// AC18 — Zod schema validation tests for Deploy Squad artifacts.

import { describe, expect, it } from 'vitest';

import {
  validateDeploymentMetadata,
  validateRunDeploySquadOutput,
  validateDeployJobPayload,
  DeploymentValidationError,
} from './deployment.js';

const validTraceEntry = {
  agent: 'domain-broker',
  action: 'compute_subdomain',
  latency_ms: 10,
  cost_usd: 0,
};

describe('validateDeploymentMetadata', () => {
  it('accepts minimal valid metadata with 1 trace entry', () => {
    const md = validateDeploymentMetadata({ agent_trace: [validTraceEntry] });
    expect(md.agent_trace).toHaveLength(1);
  });

  it('rejects empty agent_trace (Article IV audit trail)', () => {
    expect(() => validateDeploymentMetadata({ agent_trace: [] })).toThrow(
      DeploymentValidationError,
    );
  });

  it('rejects trace entry with negative latency_ms', () => {
    expect(() =>
      validateDeploymentMetadata({
        agent_trace: [{ ...validTraceEntry, latency_ms: -1 }],
      }),
    ).toThrow(DeploymentValidationError);
  });

  it('accepts optional dns_setup, ssl_setup, health_check_results', () => {
    const md = validateDeploymentMetadata({
      agent_trace: [validTraceEntry],
      dns_setup: { provider: 'wildcard', records_applied: [] },
      ssl_setup: { provider: 'wildcard-vercel', verified: true },
      health_check_results: {
        status: 200,
        checks_passed: ['status_200'],
        checks_failed: [],
        response_time_ms: 100,
        verified_at: new Date().toISOString(),
      },
    });
    expect(md.dns_setup?.provider).toBe('wildcard');
  });

  it('rejects invalid ssl_setup.provider enum', () => {
    expect(() =>
      validateDeploymentMetadata({
        agent_trace: [validTraceEntry],
        ssl_setup: { provider: 'custom-ca', verified: true },
      }),
    ).toThrow(DeploymentValidationError);
  });
});

describe('validateRunDeploySquadOutput', () => {
  it('accepts a valid success output', () => {
    const out = validateRunDeploySquadOutput({
      ok: true,
      deploymentId: '11111111-1111-1111-1111-111111111111',
      hostname: 'aloe-serum.landinglab.app',
      publishedUrl: 'https://aloe-serum.landinglab.app',
      costUsd: 0,
      durationMs: 5000,
    });
    if (!out.ok) throw new Error('expected success shape');
    expect(out.hostname).toBe('aloe-serum.landinglab.app');
  });

  it('accepts a valid failure output', () => {
    const out = validateRunDeploySquadOutput({
      ok: false,
      deploymentId: '11111111-1111-1111-1111-111111111111',
      hostname: 'x.landinglab.app',
      error: 'health_check_failed: status_200',
      errorAgent: 'publish-verifier',
      costUsd: 0,
      durationMs: 1000,
    });
    if (out.ok) throw new Error('expected failure shape');
    expect(out.errorAgent).toBe('publish-verifier');
  });

  it('rejects invalid deployment_id UUID', () => {
    expect(() =>
      validateRunDeploySquadOutput({
        ok: true,
        deploymentId: 'not-a-uuid',
        hostname: 'x.landinglab.app',
        publishedUrl: 'https://x.landinglab.app',
        costUsd: 0,
        durationMs: 0,
      }),
    ).toThrow(DeploymentValidationError);
  });
});

describe('validateDeployJobPayload', () => {
  it('accepts a subdomain payload', () => {
    const p = validateDeployJobPayload({
      landingPageId: '11111111-1111-1111-1111-111111111111',
      deploymentId: '22222222-2222-2222-2222-222222222222',
      deploymentType: 'subdomain',
      hostname: 'aloe.landinglab.app',
    });
    expect(p.deploymentType).toBe('subdomain');
  });

  it('rejects invalid deployment_type enum', () => {
    expect(() =>
      validateDeployJobPayload({
        landingPageId: '11111111-1111-1111-1111-111111111111',
        deploymentId: '22222222-2222-2222-2222-222222222222',
        deploymentType: 'bogus',
        hostname: 'x.landinglab.app',
      }),
    ).toThrow(DeploymentValidationError);
  });
});

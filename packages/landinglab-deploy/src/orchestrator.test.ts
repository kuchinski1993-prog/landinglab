// AC20 — Orchestrator unit tests (full flow, DB flow, error paths).
//
// DB mock is chainable — intercepts .select / .update patterns used by the
// orchestrator without wiring a real Drizzle-in-memory instance. State
// (updates, existingHostnames, base landing page) is externalized so each
// test asserts against materialized effects.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Database } from '@blackshop/db';
import { landingDeployments, landingDomains, landingPages } from '@blackshop/db';

import { runDeploySquad, type DeploySquadDeps } from './orchestrator.js';

function resolveTableName(table: unknown): string {
  if (table === landingDeployments) return 'landing_deployments';
  if (table === landingDomains) return 'landing_domains';
  if (table === landingPages) return 'landing_pages';
  return 'unknown';
}
import { __resetWildcardAssertionForTests } from './agents/dns-configurator.js';
import type { SpaceshipAdapter } from './providers/spaceship.js';
import type { VercelDomainsAdapter } from './providers/vercel.js';

// ─── State + Mock DB ─────────────────────────────────────────────────────

interface MockState {
  baseLandingPage: { id: string; slug: string; contentLanguage: string | null };
  copyDeckHero: string | null;
  existingHostnames: string[];
  updates: Array<{ table: string; row: Record<string, unknown> }>;
}

function makeMockState(overrides: Partial<MockState> = {}): MockState {
  return {
    baseLandingPage: {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      slug: 'aloe-serum',
      contentLanguage: 'en',
    },
    copyDeckHero: 'Aloe Serum Nightly Ritual',
    existingHostnames: [],
    updates: [],
    ...overrides,
  };
}

function makeMockDb(state: MockState): Database {
  return {
    select(shape?: Record<string, unknown>) {
      return {
        from() {
          return {
            where() {
              const cur = shape ?? {};
              return {
                async limit(_n: number) {
                  if ('slug' in cur && 'contentLanguage' in cur) {
                    return [
                      {
                        id: state.baseLandingPage.id,
                        slug: state.baseLandingPage.slug,
                        contentLanguage: state.baseLandingPage.contentLanguage,
                      },
                    ];
                  }
                  if ('htmlBody' in cur) {
                    return [
                      {
                        id: state.baseLandingPage.id,
                        htmlBody: '<html>' + 'x'.repeat(200) + '</html>',
                      },
                    ];
                  }
                  // landing_deployments collision check.
                  return state.existingHostnames.map((h, i) => ({
                    id: `existing-${i}-${h}`,
                  }));
                },
                orderBy() {
                  return {
                    async limit(_n: number) {
                      // copy_decks hero lookup
                      if (state.copyDeckHero === null) return [];
                      return [
                        {
                          content: {
                            hooks: [
                              {
                                text: state.copyDeckHero,
                                awareness_stage: 'unaware',
                              },
                            ],
                          },
                        },
                      ];
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      const tableName = resolveTableName(table);
      return {
        set(row: Record<string, unknown>) {
          return {
            where() {
              state.updates.push({ table: tableName, row });
              return Promise.resolve();
            },
          };
        },
      };
    },
  } as unknown as Database;
}

// ─── Provider mocks ──────────────────────────────────────────────────────

function makeSpaceshipMock(overrides: Partial<SpaceshipAdapter> = {}): SpaceshipAdapter {
  return {
    checkAvailability: vi.fn(async () => ({ available: true, price: 12.99 })),
    register: vi.fn(async () => ({ orderId: 'ord-123' })),
    configureDNS: vi.fn(async () => undefined),
    renew: vi.fn(async () => ({ orderId: 'renew-ord-123', cost: 12.99 })),
    ...overrides,
  };
}

function makeVercelMock(overrides: Partial<VercelDomainsAdapter> = {}): VercelDomainsAdapter {
  return {
    addDomainToProject: vi.fn(async () => ({ verified: true })),
    removeDomain: vi.fn(async () => undefined),
    getDomainStatus: vi.fn(async () => ({ verified: true })),
    attachDomain: vi.fn(async () => ({ verified: true })),
    pollVerification: vi.fn(async () => ({ verified: true })),
    ...overrides,
  };
}

function makeHappyHttp(): (url: string, opts?: RequestInit) => Promise<Response> {
  const body = `<!DOCTYPE html>
<html><head>
  <meta property="og:title" content="Aloe Serum Nightly Ritual">
</head><body><h1>Aloe Serum Nightly Ritual</h1></body></html>`;
  return async () => new Response(body, { status: 200 });
}

function makeDeps(state: MockState, overrides: Partial<DeploySquadDeps> = {}): DeploySquadDeps {
  return {
    db: makeMockDb(state),
    spaceship: makeSpaceshipMock(),
    vercel: makeVercelMock(),
    httpClient: makeHappyHttp(),
    dnsResolver: vi.fn(async () => ['cname.vercel-dns.com']),
    sleep: vi.fn(async () => undefined),
    vercelProjectId: 'prj_test',
    vercelToken: 'tok_test',
    now: () => new Date('2026-09-03T12:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  __resetWildcardAssertionForTests();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('runDeploySquad — subdomain happy path', () => {
  it('publishes + updates landing_pages.status', async () => {
    const state = makeMockState();
    const deps = makeDeps(state);
    const result = await runDeploySquad(
      {
        landingPageId: state.baseLandingPage.id,
        deploymentId: '11111111-1111-1111-1111-111111111111',
        deploymentType: 'subdomain',
        hostname: 'aloe-serum.landinglab.app',
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deploymentStatus).toBe('published');
    expect(result.hostname).toBe('aloe-serum.landinglab.app');
    expect(result.publishedUrl).toBe('https://aloe-serum.landinglab.app');
    expect(result.costUsd).toBe(0);
    expect(result.agentTrace.length).toBeGreaterThanOrEqual(5);

    // Assert landing_pages was updated with status='published'.
    const landingPageStatusUpdate = state.updates.find(
      (u) => u.table === 'landing_pages' && u.row.status === 'published',
    );
    expect(landingPageStatusUpdate).toBeDefined();
    expect(landingPageStatusUpdate?.row.currentDeploymentId).toBe(
      '11111111-1111-1111-1111-111111111111',
    );

    // Assert deployment moved through provisioning → published.
    const provisioning = state.updates.find(
      (u) =>
        u.table === 'landing_deployments' && u.row.deploymentStatus === 'provisioning',
    );
    const published = state.updates.find(
      (u) =>
        u.table === 'landing_deployments' && u.row.deploymentStatus === 'published',
    );
    expect(provisioning).toBeDefined();
    expect(published).toBeDefined();
    expect(published?.row.publishedAt).toBeInstanceOf(Date);
  });
});

describe('runDeploySquad — custom_domain purchase path', () => {
  it('purchases domain + aggregates cost + calls vercel add', async () => {
    const state = makeMockState();
    const vercel = makeVercelMock();
    const spaceship = makeSpaceshipMock({
      checkAvailability: vi.fn(async () => ({ available: true, price: 14.5 })),
    });
    const result = await runDeploySquad(
      {
        landingPageId: state.baseLandingPage.id,
        deploymentId: '22222222-2222-2222-2222-222222222222',
        deploymentType: 'custom_domain',
        hostname: 'mybrand.com',
        customDomain: 'mybrand.com',
      },
      makeDeps(state, { spaceship, vercel }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hostname).toBe('mybrand.com');
    expect(result.costUsd).toBe(14.5);
    expect(vercel.addDomainToProject).toHaveBeenCalledWith(
      'mybrand.com',
      'prj_test',
      'tok_test',
    );
    expect(spaceship.configureDNS).toHaveBeenCalled();
  });
});

describe('runDeploySquad — wildcard DNS not configured', () => {
  it('surfaces the operator-facing error via publish_failed', async () => {
    const state = makeMockState();
    const deps = makeDeps(state, {
      dnsResolver: vi.fn(async () => {
        const err = new Error('ENOTFOUND probe.landinglab.app');
        (err as unknown as { code: string }).code = 'ENOTFOUND';
        throw err;
      }),
    });
    const result = await runDeploySquad(
      {
        landingPageId: state.baseLandingPage.id,
        deploymentId: '33333333-3333-3333-3333-333333333333',
        deploymentType: 'subdomain',
        hostname: 'aloe-serum.landinglab.app',
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/wildcard_dns_not_configured/);
    expect(result.errorAgent).toBe('dns-configurator');

    // Assert deployment marked publish_failed.
    const failed = state.updates.find(
      (u) => u.table === 'landing_deployments' && u.row.deploymentStatus === 'publish_failed',
    );
    expect(failed).toBeDefined();
  });
});

describe('runDeploySquad — awaiting_ssl state', () => {
  it('stops at ssl and returns awaiting_ssl (no publish-verifier call)', async () => {
    const state = makeMockState();
    // Vercel getDomainStatus always returns unverified — SSL polling exhausts.
    const vercel = makeVercelMock({
      getDomainStatus: vi.fn(async () => ({
        verified: false,
        reason: 'awaiting_ssl_challenge',
      })),
    });
    const httpClient = vi.fn(makeHappyHttp());
    const result = await runDeploySquad(
      {
        landingPageId: state.baseLandingPage.id,
        deploymentId: '44444444-4444-4444-4444-444444444444',
        deploymentType: 'custom_domain',
        hostname: 'mybrand.com',
        customDomain: 'mybrand.com',
      },
      makeDeps(state, { vercel, httpClient, sleep: vi.fn(async () => undefined) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deploymentStatus).toBe('awaiting_ssl');
    expect(httpClient).not.toHaveBeenCalled();
    // Deployment persisted as awaiting_ssl.
    const awaiting = state.updates.find(
      (u) =>
        u.table === 'landing_deployments' && u.row.deploymentStatus === 'awaiting_ssl',
    );
    expect(awaiting).toBeDefined();
  });
});

describe('runDeploySquad — health check failure', () => {
  it('sets publish_failed with failed_checks in metadata', async () => {
    const state = makeMockState();
    const badHttp: (u: string, opts?: RequestInit) => Promise<Response> = async () =>
      new Response('Server Error', { status: 500 });
    const result = await runDeploySquad(
      {
        landingPageId: state.baseLandingPage.id,
        deploymentId: '55555555-5555-5555-5555-555555555555',
        deploymentType: 'subdomain',
        hostname: 'aloe.landinglab.app',
      },
      makeDeps(state, { httpClient: badHttp }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/health_check_failed/);
    expect(result.errorAgent).toBe('publish-verifier');
  });
});

describe('runDeploySquad — dns_provider persistence', () => {
  it('sets dns_provider=null for subdomain (wildcard) flow', async () => {
    const state = makeMockState();
    await runDeploySquad(
      {
        landingPageId: state.baseLandingPage.id,
        deploymentId: '66666666-6666-6666-6666-666666666666',
        deploymentType: 'subdomain',
        hostname: 'aloe.landinglab.app',
      },
      makeDeps(state),
    );
    const dnsUpdates = state.updates.filter(
      (u) => u.table === 'landing_deployments' && 'dnsProvider' in u.row,
    );
    expect(dnsUpdates.length).toBeGreaterThanOrEqual(1);
    // At least one update sets dnsProvider explicitly to null (wildcard signal).
    expect(dnsUpdates.some((u) => u.row.dnsProvider === null)).toBe(true);
  });

  it('sets dns_provider=spaceship for custom_domain flow', async () => {
    const state = makeMockState();
    await runDeploySquad(
      {
        landingPageId: state.baseLandingPage.id,
        deploymentId: '77777777-7777-7777-7777-777777777777',
        deploymentType: 'custom_domain',
        hostname: 'mybrand.com',
        customDomain: 'mybrand.com',
      },
      makeDeps(state),
    );
    const spaceshipDnsUpdate = state.updates.find(
      (u) =>
        u.table === 'landing_deployments' && u.row.dnsProvider === 'spaceship',
    );
    expect(spaceshipDnsUpdate).toBeDefined();
  });
});

describe('runDeploySquad — landing_domains dns_verified_at', () => {
  it('marks landing_domains after SSL provisioned (subdomain)', async () => {
    const state = makeMockState();
    await runDeploySquad(
      {
        landingPageId: state.baseLandingPage.id,
        deploymentId: '99999999-9999-9999-9999-999999999999',
        deploymentType: 'subdomain',
        hostname: 'aloe-serum.landinglab.app',
      },
      makeDeps(state),
    );
    const domainUpdate = state.updates.find(
      (u) => u.table === 'landing_domains' && u.row.dnsVerifiedAt instanceof Date,
    );
    expect(domainUpdate).toBeDefined();
  });

  it('marks landing_domains after SSL provisioned (custom_domain)', async () => {
    const state = makeMockState();
    await runDeploySquad(
      {
        landingPageId: state.baseLandingPage.id,
        deploymentId: 'aaaaaaaa-1111-1111-1111-111111111111',
        deploymentType: 'custom_domain',
        hostname: 'mybrand.com',
        customDomain: 'mybrand.com',
      },
      makeDeps(state),
    );
    const domainUpdate = state.updates.find(
      (u) => u.table === 'landing_domains' && u.row.dnsVerifiedAt instanceof Date,
    );
    expect(domainUpdate).toBeDefined();
  });

  it('does NOT mark landing_domains when SSL awaiting (custom_domain)', async () => {
    const state = makeMockState();
    const vercel = makeVercelMock({
      getDomainStatus: vi.fn(async () => ({
        verified: false,
        reason: 'awaiting_ssl_challenge',
      })),
    });
    await runDeploySquad(
      {
        landingPageId: state.baseLandingPage.id,
        deploymentId: 'bbbbbbbb-2222-2222-2222-222222222222',
        deploymentType: 'custom_domain',
        hostname: 'mybrand.com',
        customDomain: 'mybrand.com',
      },
      makeDeps(state, { vercel, sleep: vi.fn(async () => undefined) }),
    );
    const domainUpdate = state.updates.find(
      (u) => u.table === 'landing_domains',
    );
    expect(domainUpdate).toBeUndefined();
  });
});

describe('runDeploySquad — semantic rollback', () => {
  it('failure after purchase preserves cost + hostname for audit', async () => {
    const state = makeMockState();
    const vercel = makeVercelMock({
      addDomainToProject: vi.fn(async () => {
        throw new Error('vercel unreachable');
      }),
    });
    const result = await runDeploySquad(
      {
        landingPageId: state.baseLandingPage.id,
        deploymentId: '88888888-8888-8888-8888-888888888888',
        deploymentType: 'custom_domain',
        hostname: 'mybrand.com',
        customDomain: 'mybrand.com',
      },
      makeDeps(state, { vercel }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorAgent).toBe('storefront-publisher');
    // Cost from the purchase MUST be preserved (semantic rollback).
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.hostname).toBe('mybrand.com');
  });
});

describe('runDeploySquad — per-agent timeout budgets', () => {
  // Task #41: SSL slowness must NOT starve other agents' budgets, and a slow
  // single agent must surface a specific `[landinglab-deploy] <agent> timed
  // out` error attributable to that agent (not a global timeout).

  it('domain-broker timeout is enforced independently of SSL polling', async () => {
    // Minimum valid budget is 1_000ms; mock a broker that takes 3s so the
    // budget trips first regardless of scheduling jitter.
    process.env.LANDINGLAB_DEPLOY_TIMEOUT_DOMAIN_BROKER_MS = '1000';
    try {
      const state = makeMockState();
      const spaceship = makeSpaceshipMock({
        checkAvailability: vi.fn(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ available: true, price: 12.99 }), 3_000),
            ),
        ),
      });
      const result = await runDeploySquad(
        {
          landingPageId: state.baseLandingPage.id,
          deploymentId: 'cccccccc-1111-1111-1111-111111111111',
          deploymentType: 'custom_domain',
          hostname: 'mybrand.com',
          customDomain: 'mybrand.com',
        },
        makeDeps(state, { spaceship }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errorAgent).toBe('domain-broker');
      expect(result.error).toMatch(/domain-broker timed out after 1000ms/);
    } finally {
      delete process.env.LANDINGLAB_DEPLOY_TIMEOUT_DOMAIN_BROKER_MS;
    }
  }, 10_000);

  it('invalid env value falls back to default (does not crash orchestrator)', async () => {
    process.env.LANDINGLAB_DEPLOY_TIMEOUT_DOMAIN_BROKER_MS = 'not-a-number';
    try {
      const state = makeMockState();
      const result = await runDeploySquad(
        {
          landingPageId: state.baseLandingPage.id,
          deploymentId: 'dddddddd-1111-1111-1111-111111111111',
          deploymentType: 'subdomain',
          hostname: 'aloe.landinglab.app',
        },
        makeDeps(state),
      );
      // Happy path completes since default (60s) is far above the mocked latency.
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.LANDINGLAB_DEPLOY_TIMEOUT_DOMAIN_BROKER_MS;
    }
  });
});

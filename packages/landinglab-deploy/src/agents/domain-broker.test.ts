// AC13 — Domain Broker unit tests.

import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@blackshop/db';

import type { SpaceshipAdapter } from '../providers/spaceship.js';
import { runDomainBroker } from './domain-broker.js';

// ─── Mock helpers ────────────────────────────────────────────────────────

function makeMockDb(existingHostnames: string[] = []): Database {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit(_n: number) {
                  return existingHostnames.map((h, i) => ({ id: `existing-${i}-${h}` }));
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
}

function makeSpaceshipMock(overrides: Partial<SpaceshipAdapter> = {}): SpaceshipAdapter {
  return {
    checkAvailability: vi.fn(async (domain: string) => ({
      available: !domain.startsWith('taken-'),
      price: 12.99,
    })),
    register: vi.fn(async () => ({ orderId: 'ord-123' })),
    configureDNS: vi.fn(async () => undefined),
    renew: vi.fn(async () => ({ orderId: 'renew-ord-123', cost: 12.99 })),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('runDomainBroker — subdomain', () => {
  it('happy path: returns computed hostname + cost 0', async () => {
    const result = await runDomainBroker(
      {
        deploymentType: 'subdomain',
        deploymentId: '11111111-1111-1111-1111-111111111111',
        landingPageSlug: 'aloe-serum',
        contentLanguage: 'en',
      },
      { db: makeMockDb(), spaceship: makeSpaceshipMock() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hostname).toBe('aloe-serum.landinglab.app');
    expect(result.costUsd).toBe(0);
    expect(result.dnsProvider).toBe('wildcard');
  });

  it('collision with active deployment: disambiguates with hash', async () => {
    const result = await runDomainBroker(
      {
        deploymentType: 'subdomain',
        deploymentId: 'abcdefab-cdef-abcd-efab-cdefabcdefab',
        landingPageSlug: 'aloe-serum',
        contentLanguage: 'en',
      },
      {
        db: makeMockDb(['aloe-serum.landinglab.app']),
        spaceship: makeSpaceshipMock(),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hostname).toMatch(/^aloe-serum-[a-z0-9]{6}\.landinglab\.app$/);
    expect(result.costUsd).toBe(0);
  });

  it('same deployment id as existing row does NOT count as collision', async () => {
    const deploymentId = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
    const db = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async limit(_n: number) {
                    // Returns the SAME row id — this is the same deployment.
                    return [{ id: deploymentId }];
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Database;

    const result = await runDomainBroker(
      {
        deploymentType: 'subdomain',
        deploymentId,
        landingPageSlug: 'aloe-serum',
        contentLanguage: 'en',
      },
      { db, spaceship: makeSpaceshipMock() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hostname).toBe('aloe-serum.landinglab.app');
  });
});

describe('runDomainBroker — custom_domain', () => {
  it('happy path: available + purchase → returns hostname + cost', async () => {
    const spaceship = makeSpaceshipMock({
      checkAvailability: vi.fn(async () => ({ available: true, price: 14.99 })),
      register: vi.fn(async () => ({ orderId: 'ord-42' })),
    });
    const result = await runDomainBroker(
      {
        deploymentType: 'custom_domain',
        deploymentId: '11111111-1111-1111-1111-111111111111',
        landingPageSlug: 'my-brand',
        contentLanguage: 'en',
        customDomain: 'mybrand.com',
      },
      { db: makeMockDb(), spaceship },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hostname).toBe('mybrand.com');
    expect(result.costUsd).toBe(14.99);
    expect(result.dnsProvider).toBe('spaceship');
    expect(result.purchaseMeta?.orderId).toBe('ord-42');
  });

  it('invalid FQDN input → returns error without calling spaceship', async () => {
    const spaceship = makeSpaceshipMock();
    const result = await runDomainBroker(
      {
        deploymentType: 'custom_domain',
        deploymentId: '11111111-1111-1111-1111-111111111111',
        landingPageSlug: 'my-brand',
        contentLanguage: 'en',
        customDomain: 'not_a_valid_domain',
      },
      { db: makeMockDb(), spaceship },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/invalid_custom_domain/);
    expect(result.providerError).toBe(false);
    expect(spaceship.checkAvailability).not.toHaveBeenCalled();
  });

  it('unavailable domain → returns suggestions', async () => {
    const spaceship = makeSpaceshipMock({
      checkAvailability: vi.fn(async (d: string) => ({
        available: !d.startsWith('taken'),
        price: 9.99,
      })),
    });
    const result = await runDomainBroker(
      {
        deploymentType: 'custom_domain',
        deploymentId: '11111111-1111-1111-1111-111111111111',
        landingPageSlug: 'mybrand',
        contentLanguage: 'en',
        customDomain: 'takenpremium.com',
      },
      { db: makeMockDb(), spaceship },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/custom_domain_unavailable/);
    expect(result.suggestions?.length ?? 0).toBeGreaterThan(0);
  });

  it('no customDomain provided → returns suggestions only', async () => {
    const spaceship = makeSpaceshipMock();
    const result = await runDomainBroker(
      {
        deploymentType: 'custom_domain',
        deploymentId: '11111111-1111-1111-1111-111111111111',
        landingPageSlug: 'coolbrand',
        contentLanguage: 'en',
        customDomain: null,
      },
      { db: makeMockDb(), spaceship },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('customDomain_not_selected');
    expect(result.providerError).toBe(false);
    expect(result.suggestions?.length ?? 0).toBeGreaterThan(0);
  });

  it('spaceship checkAvailability throws → providerError=true', async () => {
    const spaceship = makeSpaceshipMock({
      checkAvailability: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    const result = await runDomainBroker(
      {
        deploymentType: 'custom_domain',
        deploymentId: '11111111-1111-1111-1111-111111111111',
        landingPageSlug: 'mybrand',
        contentLanguage: 'en',
        customDomain: 'mybrand.com',
      },
      { db: makeMockDb(), spaceship },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/spaceship_unavailable/);
    expect(result.providerError).toBe(true);
  });

  it('spaceship register throws → returns providerError purchase_failed', async () => {
    const spaceship = makeSpaceshipMock({
      checkAvailability: vi.fn(async () => ({ available: true, price: 12 })),
      register: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    });
    const result = await runDomainBroker(
      {
        deploymentType: 'custom_domain',
        deploymentId: '11111111-1111-1111-1111-111111111111',
        landingPageSlug: 'mybrand',
        contentLanguage: 'en',
        customDomain: 'mybrand.com',
      },
      { db: makeMockDb(), spaceship },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/spaceship_purchase_failed/);
    expect(result.providerError).toBe(true);
  });
});

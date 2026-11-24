// Domain Broker — Squad 5 Deploy Agent (AC13).
//
// Deterministic per-input:
//   - subdomain mode: compute FQDN via shared.computeSubdomainHostname;
//     verify no collision with active deployments in landing_deployments.
//     If collision (rare — same base slug + language), append 6-char hash of
//     the deployment id to preserve uniqueness.
//   - custom_domain mode: if operator picked a specific domain, verify via
//     Spaceship checkAvailability then purchase. If none picked, return
//     suggestions (best-effort, MVP wave: brand + 3 TLD variants).
//
// External surface for orchestrator = { hostname, cost_usd, meta }.
// Failure surface: throws typed error with `providerError` when Spaceship fails.

import { and, eq } from 'drizzle-orm';
import type { Database } from '@blackshop/db';
import { landingDeployments } from '@blackshop/db';

import type { SpaceshipAdapter } from '../providers/spaceship.js';
import { computeSubdomainHostname, sanitizeSlug } from './shared.js';

export interface DomainBrokerDeps {
  db: Database;
  spaceship: SpaceshipAdapter;
}

export interface DomainBrokerInput {
  deploymentType: 'subdomain' | 'custom_domain';
  deploymentId: string;
  landingPageSlug: string;
  contentLanguage: string;
  /** Only used in custom_domain mode. When null, broker returns suggestions. */
  customDomain?: string | null;
  /** Brand hint for suggestion mode. Falls back to landingPageSlug. */
  brandName?: string;
}

export type DomainBrokerOutput =
  | {
      ok: true;
      hostname: string;
      costUsd: number;
      /** 'wildcard' | 'spaceship' — used to persist landing_deployments.dns_provider. */
      dnsProvider: 'wildcard' | 'spaceship';
      /** Populated only in custom_domain purchase mode. */
      purchaseMeta?: { orderId: string; years: number };
      /** Suggestions when custom_domain mode was called without a picked domain. */
      suggestions?: Array<{ domain: string; available: boolean; priceUsd?: number }>;
    }
  | {
      ok: false;
      error: string;
      /** True when the failure came from Spaceship (network / rate / config). */
      providerError: boolean;
      suggestions?: Array<{ domain: string; available: boolean; priceUsd?: number }>;
    };

// FQDN check per RFC 1034 §3.5 — labels 1-63 alnum/hyphen, at least one dot.
const FQDN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/** Wave 2 TLD suggestion set — MVP. Wave 3 could expand via Spaceship API. */
const SUGGESTION_TLDS = ['com', 'io', 'co', 'store', 'shop'];

export async function runDomainBroker(
  input: DomainBrokerInput,
  deps: DomainBrokerDeps,
): Promise<DomainBrokerOutput> {
  if (input.deploymentType === 'subdomain') {
    return handleSubdomain(input, deps);
  }
  return handleCustomDomain(input, deps);
}

// ─── Subdomain ───────────────────────────────────────────────────────────

async function handleSubdomain(
  input: DomainBrokerInput,
  deps: DomainBrokerDeps,
): Promise<DomainBrokerOutput> {
  const baseHostname = computeSubdomainHostname(input.landingPageSlug, input.contentLanguage);

  const collision = await hasActiveDeployment(deps.db, baseHostname, input.deploymentId);
  if (!collision) {
    return {
      ok: true,
      hostname: baseHostname,
      costUsd: 0,
      dnsProvider: 'wildcard',
    };
  }

  // Rare — same sanitized slug already published. Disambiguate with hash of
  // deploymentId (deterministic per attempt, avoids race with concurrent brokers).
  const suffix = input.deploymentId.replace(/-/g, '').slice(0, 6);
  const [label, ...rest] = baseHostname.split('.');
  const disambiguated = `${label}-${suffix}.${rest.join('.')}`;
  return {
    ok: true,
    hostname: disambiguated,
    costUsd: 0,
    dnsProvider: 'wildcard',
  };
}

async function hasActiveDeployment(
  db: Database,
  hostname: string,
  currentDeploymentId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: landingDeployments.id })
    .from(landingDeployments)
    .where(
      and(
        eq(landingDeployments.hostname, hostname),
        eq(landingDeployments.deploymentStatus, 'published'),
      ),
    )
    .limit(2);
  return rows.some((r) => r.id !== currentDeploymentId);
}

// ─── Custom domain ───────────────────────────────────────────────────────

async function handleCustomDomain(
  input: DomainBrokerInput,
  deps: DomainBrokerDeps,
): Promise<DomainBrokerOutput> {
  // Case A: operator did not pick — return suggestions.
  if (!input.customDomain) {
    try {
      const suggestions = await buildSuggestions(input, deps);
      return {
        ok: false,
        error: 'customDomain_not_selected',
        providerError: false,
        suggestions,
      };
    } catch (err) {
      return {
        ok: false,
        error: `spaceship_unavailable: ${(err as Error).message}`,
        providerError: true,
      };
    }
  }

  const domain = input.customDomain.trim().toLowerCase();

  if (!FQDN_RE.test(domain)) {
    return {
      ok: false,
      error: `invalid_custom_domain: "${domain}" is not a valid FQDN`,
      providerError: false,
    };
  }

  // Case B: operator picked — check availability + purchase.
  let availability: Awaited<ReturnType<SpaceshipAdapter['checkAvailability']>>;
  try {
    availability = await deps.spaceship.checkAvailability(domain);
  } catch (err) {
    return {
      ok: false,
      error: `spaceship_unavailable: checkAvailability failed for ${domain}: ${(err as Error).message}`,
      providerError: true,
    };
  }

  if (!availability.available) {
    let suggestions: Array<{ domain: string; available: boolean; priceUsd?: number }> = [];
    try {
      suggestions = await buildSuggestions(input, deps);
    } catch {
      /* suggestions best-effort */
    }
    return {
      ok: false,
      error: `custom_domain_unavailable: ${domain} is not available`,
      providerError: false,
      suggestions,
    };
  }

  let registration: Awaited<ReturnType<SpaceshipAdapter['register']>>;
  try {
    registration = await deps.spaceship.register(domain, { years: 1 });
  } catch (err) {
    return {
      ok: false,
      error: `spaceship_purchase_failed: register ${domain}: ${(err as Error).message}`,
      providerError: true,
    };
  }

  return {
    ok: true,
    hostname: domain,
    costUsd: availability.price ?? 0,
    dnsProvider: 'spaceship',
    purchaseMeta: { orderId: registration.orderId, years: 1 },
  };
}

async function buildSuggestions(
  input: DomainBrokerInput,
  deps: DomainBrokerDeps,
): Promise<Array<{ domain: string; available: boolean; priceUsd?: number }>> {
  const stem = sanitizeSlug(input.brandName ?? input.landingPageSlug).replace(/-/g, '');
  if (!stem) return [];

  const candidates = SUGGESTION_TLDS.slice(0, 5).map((tld) => `${stem}.${tld}`);
  const results = await Promise.all(
    candidates.map(async (domain) => {
      try {
        const { available, price } = await deps.spaceship.checkAvailability(domain);
        return { domain, available, priceUsd: price };
      } catch {
        return { domain, available: false };
      }
    }),
  );
  return results;
}

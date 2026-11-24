// DNS Configurator — Squad 5 Deploy Agent (AC14).
//
// Story 13.8 Wave 2 — wildcard DNS runtime assertion (from @po concern #3).
//
// Two modes:
//   - subdomain: assert wildcard *.landinglab.app resolves once per orchestrator
//     invocation. When passing, no per-landing DNS work needed (wildcard covers).
//     When failing, throw a clear operator-facing error so backoffice surfaces
//     it in place of a mysterious downstream health-check timeout.
//   - custom_domain: apply CNAME/A/TXT (via Spaceship) so Vercel Domains routes
//     the operator's FQDN to landinglab-storefront.

import type { DnsRecord } from '@blackshop/landinglab-domains';

import type { SpaceshipAdapter } from '../providers/spaceship.js';

export interface DnsConfiguratorDeps {
  spaceship: SpaceshipAdapter;
  /** Injectable resolver — defaults to node:dns.promises. Tests mock it. */
  dnsResolver?: (hostname: string, rrtype: 'A' | 'CNAME') => Promise<string[]>;
}

export interface DnsConfiguratorInput {
  deploymentType: 'subdomain' | 'custom_domain';
  hostname: string;
  /** Verification token from Vercel Domains add (custom_domain only). */
  vercelVerificationToken?: string;
}

export interface DnsConfiguratorOutput {
  ok: true;
  dnsRecords: DnsRecord[];
  /** 'wildcard' when nothing was applied; 'spaceship' when records were added. */
  provider: 'wildcard' | 'spaceship';
  skippedReason?: string;
  propagationEstimateSeconds?: number;
  warning?: string;
}

const PROBE_HOST = 'probe.landinglab.app';
const VERCEL_CNAME_TARGET = 'cname.vercel-dns.com';
const VERCEL_A_TARGET = '76.76.21.21';
const CUSTOM_DOMAIN_PROPAGATION_SECONDS = 300;

/** Cached result per Node process — assertion runs once until proven ok. */
let wildcardAssertionOk: boolean | null = null;

/** Test-only: reset the module-level cache between test cases. */
export function __resetWildcardAssertionForTests(): void {
  wildcardAssertionOk = null;
}

async function defaultResolve(hostname: string, rrtype: 'A' | 'CNAME'): Promise<string[]> {
  const dns = await import('node:dns');
  const resolver = dns.promises;
  if (rrtype === 'CNAME') return resolver.resolveCname(hostname);
  return resolver.resolve4(hostname);
}

async function assertWildcardConfigured(
  resolver: (hostname: string, rrtype: 'A' | 'CNAME') => Promise<string[]>,
): Promise<void> {
  if (wildcardAssertionOk === true) return;
  try {
    // CNAME preferred; fall back to A record if resolver rejects CNAME.
    try {
      await resolver(PROBE_HOST, 'CNAME');
    } catch {
      await resolver(PROBE_HOST, 'A');
    }
    wildcardAssertionOk = true;
  } catch (err) {
    wildcardAssertionOk = false;
    throw new Error(
      `wildcard_dns_not_configured: *.landinglab.app is not resolvable (${(err as Error).message}). ` +
        'Contact ops to add wildcard DNS record + Vercel wildcard domain config.',
    );
  }
}

export async function runDnsConfigurator(
  input: DnsConfiguratorInput,
  deps: DnsConfiguratorDeps,
): Promise<DnsConfiguratorOutput> {
  const resolver = deps.dnsResolver ?? defaultResolve;

  if (input.deploymentType === 'subdomain') {
    await assertWildcardConfigured(resolver);
    return {
      ok: true,
      dnsRecords: [],
      provider: 'wildcard',
      skippedReason: 'wildcard_handles',
    };
  }

  // custom_domain — apply records via Spaceship.
  const records: DnsRecord[] = [
    { type: 'CNAME', name: input.hostname, value: VERCEL_CNAME_TARGET, ttl: 300 },
    { type: 'A', name: input.hostname, value: VERCEL_A_TARGET, ttl: 300 },
  ];
  if (input.vercelVerificationToken) {
    records.push({
      type: 'TXT',
      name: `_vercel.${input.hostname}`,
      value: input.vercelVerificationToken,
      ttl: 300,
    });
  }

  try {
    await deps.spaceship.configureDNS(input.hostname, records);
  } catch (err) {
    throw new Error(
      `dns_configurator_spaceship_failed: ${input.hostname}: ${(err as Error).message}`,
    );
  }

  return {
    ok: true,
    dnsRecords: records,
    provider: 'spaceship',
    propagationEstimateSeconds: CUSTOM_DOMAIN_PROPAGATION_SECONDS,
  };
}

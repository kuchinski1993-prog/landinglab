// Storefront Publisher — Squad 5 Deploy Agent (AC15).
//
// Story 13.8 Wave 2.
//
// - subdomain: no rebuild required (landinglab-storefront serves via runtime
//   hostname lookup + wildcard route). Verifies landing_pages row exists and
//   has a non-trivial html_body.
// - custom_domain: adds the FQDN to the Vercel project (SSL is auto-triggered).

import { eq } from 'drizzle-orm';
import type { Database } from '@blackshop/db';
import { landingPages } from '@blackshop/db';

import type { VercelDomainsAdapter } from '../providers/vercel.js';

export interface StorefrontPublisherDeps {
  db: Database;
  vercel: VercelDomainsAdapter;
  /** Env-provided project id. Falls back to process.env at agent boundary. */
  vercelProjectId?: string;
  vercelToken?: string;
}

export interface StorefrontPublisherInput {
  deploymentType: 'subdomain' | 'custom_domain';
  landingPageId: string;
  hostname: string;
}

export interface StorefrontPublisherOutput {
  ok: true;
  storefrontReady: true;
  vercelDomainAdded?: boolean;
  vercelInitiallyVerified?: boolean;
}

const HTML_BODY_MIN_LENGTH = 100;

export async function runStorefrontPublisher(
  input: StorefrontPublisherInput,
  deps: StorefrontPublisherDeps,
): Promise<StorefrontPublisherOutput> {
  await assertLandingReady(deps.db, input.landingPageId);

  if (input.deploymentType === 'subdomain') {
    return { ok: true, storefrontReady: true };
  }

  const projectId = deps.vercelProjectId ?? process.env.LANDINGLAB_VERCEL_PROJECT_ID ?? '';
  const token = deps.vercelToken ?? process.env.LANDINGLAB_VERCEL_TOKEN ?? '';
  if (!projectId || !token) {
    throw new Error(
      'storefront_publisher_config: LANDINGLAB_VERCEL_PROJECT_ID or LANDINGLAB_VERCEL_TOKEN not set',
    );
  }

  const result = await deps.vercel.addDomainToProject(input.hostname, projectId, token);
  return {
    ok: true,
    storefrontReady: true,
    vercelDomainAdded: true,
    vercelInitiallyVerified: result.verified,
  };
}

async function assertLandingReady(db: Database, landingPageId: string): Promise<void> {
  const rows = await db
    .select({ id: landingPages.id, htmlBody: landingPages.htmlBody })
    .from(landingPages)
    .where(eq(landingPages.id, landingPageId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`storefront_publisher: landing_page not found id=${landingPageId}`);
  }
  const body = row.htmlBody ?? '';
  if (body.length < HTML_BODY_MIN_LENGTH) {
    throw new Error(
      `storefront_publisher: landing_page html_body too short (${body.length} chars, min ${HTML_BODY_MIN_LENGTH})`,
    );
  }
}

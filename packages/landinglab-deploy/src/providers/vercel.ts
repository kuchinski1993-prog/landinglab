// Vercel Domains provider — Wave 2 delegates to real client from
// @blackshop/landinglab-domains (which now hosts the real HTTP impl).
//
// Story 13.8, Wave 2:
//   - Re-export VercelDomainsAdapter interface from landinglab-domains
//   - createVercelClient() returns real client from createVercelDomainsClient()

import { createVercelDomainsClient } from '@blackshop/landinglab-domains';
import type { VercelDomainsAdapter } from '@blackshop/landinglab-domains';

export type { VercelDomainsAdapter };

/** Factory — returns the real Vercel Domains client (Wave 2). */
export function createVercelClient(): VercelDomainsAdapter {
  return createVercelDomainsClient();
}

// Provider barrel — exposes DI-injectable clients to orchestrator + tests.
//
// Story 13.8, Wave 1 (Foundation).

export { createSpaceshipClient, type SpaceshipAdapter, type DnsRecord } from './spaceship.js';
export { createVercelClient, type VercelDomainsAdapter } from './vercel.js';
export {
  ProviderConfigError,
  ProviderRetryableError,
  NotImplementedError,
} from './errors.js';

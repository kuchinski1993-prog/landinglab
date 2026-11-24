// @blackshop/landinglab-deploy — Squad 5 (Deploy) of LandingLab AI Autopilot.
//
// Public entry point. Consumers (worker processor, tests, backoffice):
//   import { runDeploySquad, validateDeployJobPayload } from '@blackshop/landinglab-deploy';
//
// Story: docs/stories/13.8.landinglab-deploy-squad.story.md
// Wave 1 (Foundation):    schema + provider stubs + orchestrator stub + Vercel adapter stub.  [THIS WAVE]
// Wave 2 (Agents):        5 agents (domain-broker..publish-verifier) + real HTTP + wildcard DNS assertion.
// Wave 3 (Integration):   worker processor + backoffice PublishActions + DomainPurchaseModal + E2E tests.

// ─── Orchestrator (Wave 2 real impl) ─────────────────────────────────────
export {
  runDeploySquad,
  type RunDeploySquadInput,
  type RunDeploySquadOutput,
  type RunDeploySquadSuccessOutput,
  type RunDeploySquadFailureOutput,
  type DeploySquadDeps,
} from './orchestrator.js';

// ─── Agents (Wave 2 — individually re-exported for tests + composition) ──
export { computeSubdomainHostname, sanitizeSlug, RESERVED_SUBDOMAINS, ROOT_DOMAIN, verificationUrlFor } from './agents/shared.js';
export { runDomainBroker, type DomainBrokerInput, type DomainBrokerOutput, type DomainBrokerDeps } from './agents/domain-broker.js';
export {
  runDnsConfigurator,
  __resetWildcardAssertionForTests,
  type DnsConfiguratorInput,
  type DnsConfiguratorOutput,
  type DnsConfiguratorDeps,
} from './agents/dns-configurator.js';
export {
  runStorefrontPublisher,
  type StorefrontPublisherInput,
  type StorefrontPublisherOutput,
  type StorefrontPublisherDeps,
} from './agents/storefront-publisher.js';
export {
  runSslValidator,
  type SslValidatorInput,
  type SslValidatorOutput,
  type SslValidatorDeps,
} from './agents/ssl-validator.js';
export {
  runPublishVerifier,
  type PublishVerifierInput,
  type PublishVerifierOutput,
  type PublishVerifierDeps,
} from './agents/publish-verifier.js';

// ─── Deployment / DNS / SSL / Metadata schemas ───────────────────────────
export {
  DeploymentTypeSchema,
  SslStatusSchema,
  DeploymentStatusSchema,
  DnsRecordSchema,
  AgentTraceEntrySchema,
  DnsSetupSchema,
  SslSetupSchema,
  HealthCheckResultSchema,
  DeploymentMetadataSchema,
  DeployJobPayloadSchema,
  RunDeploySquadOutputSchema,
  validateDeployJobPayload,
  validateDeploymentMetadata,
  validateRunDeploySquadOutput,
  DeploymentValidationError,
  type DeploymentType,
  type SslStatus,
  type DeploymentStatus,
  type DnsRecord,
  type AgentTraceEntry,
  type DnsSetup,
  type SslSetup,
  type HealthCheckResult,
  type DeploymentMetadata,
  type DeployJobPayload,
} from './schema/deployment.js';

// ─── Providers (Wave 2 real HTTP) ────────────────────────────────────────
export {
  createSpaceshipClient,
  createVercelClient,
  ProviderConfigError,
  ProviderRetryableError,
  NotImplementedError,
  type SpaceshipAdapter,
  type VercelDomainsAdapter,
} from './providers/index.js';

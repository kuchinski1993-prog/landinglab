// @blackshop/landinglab-research — Squad 1 (Product Research) do LandingLab AI Autopilot.
//
// Ponto de entrada público. Consumers (worker processor, CLI de debug):
//   import { runProductResearch, pirSchema } from '@blackshop/landinglab-research';
//
// Story: docs/stories/13.3.landinglab-ai-foundation.story.md
// Wave 1 (Foundation): schema + providers stub + orchestrator stub.
// Wave 2 (Agents):     src/agents/*.ts + orchestrator real + providers HTTP real.
// Wave 3 (Integration): worker processor + backoffice form + E2E.

export {
  runProductResearch,
  type RunProductResearchInput,
  type RunProductResearchOutput,
  type OrchestratorDeps,
} from './orchestrator.js';

// PIR schema (validated by Sage, consumed by Copy/Visual/Build squads)
export {
  pirSchema,
  validatePir,
  calcOpportunityScore,
  PirValidationError,
  identitySchema,
  marketSchema,
  avatarSchema,
  vocSchema,
  desiredOutcomesSchema,
  awarenessStageSchema,
  valueEquationSchema,
  evidenceSchema,
  type Pir,
  type Identity,
  type Market,
  type Avatar,
  type Voc,
  type DesiredOutcomes,
  type AwarenessStage,
  type ValueEquation,
  type Evidence,
} from './schema/pir.js';

// Provider clients — exportados pra Wave 2 (agents) e testes.
export {
  createSerpApiClient,
  createFirecrawlClient,
  createApifyClient,
  createPerplexityClient,
  createClaudeVisionClient,
  createGeminiVisionClient,
  createCheerioClient,
  NotImplementedError,
  ProviderConfigError,
  ProviderHttpError,
  type SerpApiClient,
  type FirecrawlClient,
  type ApifyClient,
  type PerplexityClient,
  type ClaudeVisionClient,
  type GeminiVisionClient,
  type GeminiContentBlock,
  type GeminiMessagesOpts,
  type GeminiMessagesResult,
  type GeminiModel,
  type CheerioClient,
  type CheerioExtractResult,
  type CheerioIdentity,
  type CheerioSource,
  type CheerioStatus,
} from './providers/index.js';

// Wave 2: agent-level helpers e types (usados pelo worker processor e testes).
export {
  runSpecHunter,
  type SpecHunterInput,
  type ProductExtraction,
  runReviewMiner,
  type ReviewMinerInput,
  runMarketAnalyst,
  type MarketAnalystInput,
  type MarketIntel,
  runLensScout,
  type LensScoutInput,
  type LensScoutData,
  runVisionVerifier,
  type VisionVerifierInput,
  type VisionVerifierData,
  runPirSynthesizer,
  type PirSynthesizerInput,
  type PirSynthesizerData,
  type PirSynthesizerResult,
  type WorkerOutput,
  type TraceEntry,
} from './agents/research-lead.js';

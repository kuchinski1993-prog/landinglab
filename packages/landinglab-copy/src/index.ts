// @blackshop/landinglab-copy — Squad 2 (Copy High-Conversion) do LandingLab AI Autopilot.
//
// Ponto de entrada público. Consumers (worker processor, testes):
//   import { runCopySquad, CopyDeckSchema } from '@blackshop/landinglab-copy';
//
// Story: docs/stories/13.4.landinglab-copy-squad.story.md
// Wave 1 (Foundation):   schema + providers stub + orchestrator stub. [ESTA WAVE]
// Wave 2 (Agents):       src/agents/*.ts + orchestrator real + prompts populados.
// Wave 3 (Integration):  worker processor + backoffice multi-select + E2E tests.

// ─── Orchestrator (Wave 2 real impl) ─────────────────────────────────────
export {
  runCopySquad,
  type RunCopySquadInput,
  type RunCopySquadOutput,
  type CopySquadDeps,
  type CopyTraceEntry,
} from './orchestrator.js';

// ─── Individual agents (usable standalone; primary consumer is orchestrator) ─
export { runHormoziAgent } from './agents/hormozi.js';
export { runSchwartzAgent } from './agents/schwartz.js';
export { runHalbertAgent } from './agents/halbert.js';
export { runCialdiniAgent } from './agents/cialdini.js';
export { runVossAgent } from './agents/voss.js';
export {
  runCopyChief,
  type CopyChiefInput,
  type CopyChiefDeps,
  type CopyChiefResult,
} from './agents/copy-chief.js';
export {
  type CopyContributions,
  type CopyWorkerOutput,
  makeFailedCopyWorkerOutput,
} from './agents/types.js';

// ─── CopyDeck schema (validated by Copy Chief, consumed by Squad 3) ──────
export {
  CopyDeckSchema,
  validateCopyDeck,
  CopyDeckValidationError,
  CopyLanguageEnum,
  AwarenessStageEnum,
  FrameworkSourceEnum,
  UrgencyTypeEnum,
  CtaVariantEnum,
  SocialProofTypeEnum,
  VossTechniqueEnum,
  HookSchema,
  BenefitBulletSchema,
  CtaSchema,
  FaqItemSchema,
  OfferBonusSchema,
  OfferStackSchema,
  SocialProofBlockSchema,
  ContributingAgentSchema,
  type CopyDeck,
  type CopyLanguage,
  type AwarenessStage,
  type FrameworkSource,
  type UrgencyType,
  type CtaVariant,
  type SocialProofType,
  type VossTechnique,
  type Hook,
  type BenefitBullet,
  type Cta,
  type FaqItem,
  type OfferBonus,
  type OfferStack,
  type SocialProofBlock,
  type ContributingAgent,
} from './schema/copy-deck.js';

// ─── Claude text client (used by all 6 copywriters — Wave 2 concretizes) ─
export {
  createClaudeTextClient,
  type ClaudeTextClient,
  type ClaudeTextMessagesOpts,
  type ClaudeTextMessagesResult,
  type ClaudeModel,
} from './providers/claude.js';

// ─── Provider errors ─────────────────────────────────────────────────────
export {
  NotImplementedError,
  ProviderConfigError,
  ProviderHttpError,
} from './providers/errors.js';

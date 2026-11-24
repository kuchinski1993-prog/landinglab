// @blackshop/landinglab-visual — Squad 3 (Visual & Brand Forge) do LandingLab AI Autopilot.
//
// Ponto de entrada público. Consumers (worker processor, testes, backoffice):
//   import { runVisualSquad, VisualAssetsSchema } from '@blackshop/landinglab-visual';
//
// Story: docs/stories/13.5.landinglab-visual-squad.story.md
// Wave 1 (Foundation):   schema completo + providers stub + orchestrator stub. [ESTA WAVE]
// Wave 2 (Agents):       src/agents/*.ts + orchestrator real + prompts populados + providers reais.
// Wave 3 (Integration):  worker processor + backoffice VisualAssetsGallery + E2E tests.

// ─── Orchestrator (Wave 2 real impl) ─────────────────────────────────────
export {
  runVisualSquad,
  type RunVisualSquadInput,
  type RunVisualSquadOutput,
  type VisualSquadDeps,
  type VisualTraceEntry,
} from './orchestrator.js';

// ─── VisualAssets schema (validated by Visual Director, consumed by Squad 4) ──
export {
  VisualAssetsSchema,
  validateVisualAssets,
  VisualAssetsValidationError,
  rejectsBannedBrands,
  BANNED_BRAND_TERMS,
  BrandSchema,
  LogoUrlsSchema,
  BrandPaletteSchema,
  BrandTypographySchema,
  AssetsSchema,
  HeroSchema,
  HeroUrlsBySizeSchema,
  IconSchema,
  ContributingAgentSchema,
  type VisualAssets,
  type Brand,
  type LogoUrls,
  type BrandPalette,
  type BrandTypography,
  type Assets,
  type Hero,
  type HeroUrlsBySize,
  type Icon,
  type ContributingAgent,
} from './schema/visual-assets.js';

// ─── Provider abstraction (interface + factories) ────────────────────────
export {
  createFreepikProvider,
  createHiggsfieldProvider,
  createClaudeTextClient,
  NotImplementedError,
  ProviderConfigError,
  ProviderHttpError,
  FreepikProviderError,
  HiggsFieldProviderError,
  type ImageProvider,
  type GenerateImageInput,
  type GenerateImageOutput,
  type ImageSize,
  type ClaudeTextClient,
  type ClaudeTextMessagesOpts,
  type ClaudeTextMessagesResult,
  type ClaudeModel,
} from './providers/index.js';

// ─── Agent runners (Wave 2 real impl) ────────────────────────────────────
export { runVisualDirector } from './agents/visual-director.js';
export { runBrandForge } from './agents/brand-forge.js';
export { runHeroDesigner } from './agents/hero-designer.js';
export { runLifestyleComposer } from './agents/lifestyle-composer.js';
export { runIconGenerator } from './agents/icon-generator.js';
export { runSocialProofDesigner } from './agents/social-proof-designer.js';
export type {
  VisualAgentName,
  VisualDirection,
  BrandForgeOutput,
  HeroDesignerOutput,
  LifestyleComposerOutput,
  IconGeneratorOutput,
  SocialProofDesignerOutput,
} from './agents/types.js';

// ─── Prompt builders (Wave 2 completes; Wave 1 exports stubs for typing) ──
export { buildBrandForgeSystemPrompt } from './prompts/brand-forge.js';
export { buildHeroDesignerSystemPrompt } from './prompts/hero.js';
export { buildLifestyleComposerSystemPrompt } from './prompts/lifestyle.js';
export { buildIconGeneratorSystemPrompt } from './prompts/icons.js';
export { buildSocialProofDesignerSystemPrompt } from './prompts/social-proof.js';

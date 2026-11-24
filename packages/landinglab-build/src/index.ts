// @blackshop/landinglab-build — Squad 4 (Build HTML) of LandingLab AI Autopilot.
//
// Public entry point. Consumers (worker processor, tests, backoffice):
//   import { runBuildSquad, validateBuildOutput } from '@blackshop/landinglab-build';
//
// Story: docs/stories/13.6.landinglab-build-squad.story.md
// Wave 1 (Foundation):   schema + provider stub + orchestrator stub + React SSR de-risk.  [THIS WAVE]
// Wave 2 (Agents):       5 agents (template-selector..performance-optimizer) + 3 templates + real HTTP.
// Wave 3 (Integration):  worker processor + backoffice HtmlPreview + E2E tests.

// ─── Orchestrator (Wave 2 real impl) ─────────────────────────────────────
export {
  runBuildSquad,
  type RunBuildSquadInput,
  type RunBuildSquadOutput,
  type BuildSquadDeps,
  type BuildTraceEntry,
} from './orchestrator.js';

// ─── BuildOutput / BuildMetadata / SeoTags schemas ───────────────────────
export {
  TemplateNameSchema,
  BuildMetadataSchema,
  SeoScoresSchema,
  OpenGraphTagsSchema,
  TwitterCardTagsSchema,
  HreflangTagSchema,
  SeoTagsSchema,
  BuildOutputSchema,
  validateBuildOutput,
  validateBuildMetadata,
  validateSeoTags,
  BuildOutputValidationError,
  type TemplateName,
  type BuildMetadata,
  type SeoScores,
  type OpenGraphTags,
  type TwitterCardTags,
  type HreflangTag,
  type SeoTags,
  type BuildOutput,
} from './schema/build-output.js';

// ─── Provider (Wave 2 real HTTP) ─────────────────────────────────────────
export {
  createClaudeHaikuClient,
  NotImplementedError,
  type ClaudeHaikuClient,
  type HaikuMetaResult,
} from './providers/claude-haiku.js';

// ─── Agents (Wave 2) ─────────────────────────────────────────────────────
export { selectTemplate, type TemplateSelection } from './agents/template-selector.js';
export {
  composeSlots,
  type ComposeSlotsInput,
  // SM-5.5 — skeleton-mode Bepurex slot composer
  composeBepurexSlots,
  type ComposeBepurexSlotsInput,
  type ExtractedSourceLike,
  type BrandExtractLike,
  type ExtractedCommerceReview,
  type ExtractedCommerceBundle,
  type ExtractedFaqItem,
  type ExtractedTestimonial,
  type ExtractedDynamicExtra,
} from './agents/content-composer.js';
export {
  buildHtml,
  type BuildHtmlInput,
  type BuildHtmlOutput,
  type BuildHtmlSlots,
} from './agents/html-builder.js';
export {
  generateSeoTags,
  type SeoOptimizerInput,
  type SeoOptimizerOutput,
} from './agents/seo-optimizer.js';
export {
  optimizePerformance,
  type PerformanceInput,
  type PerformanceOutput,
} from './agents/performance-optimizer.js';
export {
  runBuildChief,
  type BuildChiefInput,
  type BuildChiefOutput,
} from './agents/build-chief.js';
export type { BuildAgentName, BuildAgentTrace } from './agents/types.js';

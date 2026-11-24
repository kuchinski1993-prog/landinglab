// Build Output — Zod schemas (Story 13.6 — Squad 4, AC15).
//
// Validates every artifact produced by the Build Squad orchestrator:
//   - BuildMetadataSchema → persisted in landing_pages.build_metadata (jsonb)
//   - SeoTagsSchema       → intermediate artifact from seo-optimizer agent
//   - BuildOutputSchema   → full return of runBuildSquad per language variant
//
// Article IV (No Invention) enforcement:
//   1. `generation_notes` min 10 chars → forces the orchestrator to write an
//      auditable trail (which agents ran, which template was chosen, which
//      fallbacks fired). Never allowed to be empty.
//   2. `template_used` is a strict enum → prevents "creative" template names
//      not backed by an actual React component in packages/landinglab-render/.
//   3. `meta_description` capped at 160 chars → prevents LLM (Claude Haiku)
//      hallucinating longer descriptions that would be silently truncated by
//      Google/OG scrapers, breaking SEO audit trail. Also enforces min 50
//      chars so descriptions carry actual content (not "Buy now").
//   4. runtime `validateBuildOutput()` throws BuildOutputValidationError with
//      pretty error report, mirroring landinglab-visual pattern.
//
// Reference pattern: packages/landinglab-visual/src/schema/visual-assets.ts.

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Template enum — the 3 templates that will live in
// packages/landinglab-render/src/templates/landinglab/ (Wave 2).
// ─────────────────────────────────────────────────────────────────────────

export const TemplateNameSchema = z.enum([
  'long-form-advertorial',
  'short-form-direct',
  'story-driven',
  // Fase 3: default a partir de 2026-09. layout-planner monta a ordem.
  'dynamic-blocks',
  // SM-1.4: Skeleton Mode — versioned skeletons per site type (FR-8, ADR-8).
  'bepurex-advertorial-v1',
  'bepurex-landing-v1',
]);
export type TemplateName = z.infer<typeof TemplateNameSchema>;

// ─────────────────────────────────────────────────────────────────────────
// SEO scores (optional metrics from seo-optimizer)
// ─────────────────────────────────────────────────────────────────────────

export const SeoScoresSchema = z
  .object({
    meta_length: z.number().int().min(0).max(160),
    jsonld_present: z.boolean(),
    hreflang_count: z.number().int().min(0).max(20),
  })
  .strict();
export type SeoScores = z.infer<typeof SeoScoresSchema>;

// ─────────────────────────────────────────────────────────────────────────
// BuildMetadata — persisted in landing_pages.build_metadata
//
// Article IV: generation_notes MIN 10 chars → auditable trail.
// ─────────────────────────────────────────────────────────────────────────

export const BuildMetadataSchema = z
  .object({
    template_used: TemplateNameSchema,
    generation_notes: z
      .string()
      .min(10, 'generation_notes must have >= 10 chars (Article IV audit trail)'),
    agents_used: z
      .array(z.string().min(1))
      .min(1, 'agents_used must list at least 1 agent'),
    seo_scores: SeoScoresSchema.optional(),
    lighthouse_estimate: z.string().optional(),
    seo_score: z.number().min(0).max(100).optional(),
  })
  .strict();
export type BuildMetadata = z.infer<typeof BuildMetadataSchema>;

// ─────────────────────────────────────────────────────────────────────────
// SeoTags — intermediate artifact from seo-optimizer agent (Wave 2 uses it).
//
// @po concern #3: meta_description MUST be .max(160) — prevents Claude Haiku
// hallucinating descriptions that Google will silently truncate.
// Minimum 50 chars — forces actual content over placeholders like "Buy now".
// ─────────────────────────────────────────────────────────────────────────

export const OpenGraphTagsSchema = z
  .object({
    title: z.string().min(1).max(70),
    description: z.string().min(50).max(160),
    image: z.string().url(),
    type: z.string().default('product'),
    locale: z.string().min(2).max(10),
  })
  .strict();
export type OpenGraphTags = z.infer<typeof OpenGraphTagsSchema>;

export const TwitterCardTagsSchema = z
  .object({
    card: z.enum(['summary', 'summary_large_image']).default('summary_large_image'),
    title: z.string().min(1).max(70),
    description: z.string().min(50).max(160),
    image: z.string().url(),
  })
  .strict();
export type TwitterCardTags = z.infer<typeof TwitterCardTagsSchema>;

export const HreflangTagSchema = z
  .object({
    lang: z.string().min(2).max(10),
    href: z.string().url(),
  })
  .strict();
export type HreflangTag = z.infer<typeof HreflangTagSchema>;

export const SeoTagsSchema = z
  .object({
    meta_description: z
      .string()
      .min(50, 'meta_description too short (min 50 chars — forces real content)')
      .max(160, 'meta_description too long (max 160 chars — Google truncates beyond that)'),
    canonical_url: z.string().url().optional(),
    open_graph: OpenGraphTagsSchema,
    twitter_card: TwitterCardTagsSchema,
    hreflang: z.array(HreflangTagSchema).default([]),
    // JSON-LD Product schema — free-form object; validated deeper by seo-optimizer.
    jsonld_product: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type SeoTags = z.infer<typeof SeoTagsSchema>;

// ─────────────────────────────────────────────────────────────────────────
// BuildOutput — final artifact per language variant.
// Composed by orchestrator.ts (Wave 2 real impl).
// ─────────────────────────────────────────────────────────────────────────

export const BuildOutputSchema = z
  .object({
    language: z.string().min(2).max(5),
    html: z.string().min(500, 'html body suspiciously small — likely a bug'),
    metadata: BuildMetadataSchema,
    seo_tags: SeoTagsSchema.optional(),
  })
  .strict();
export type BuildOutput = z.infer<typeof BuildOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Runtime validators — mirror landinglab-visual pattern
// ─────────────────────────────────────────────────────────────────────────

export class BuildOutputValidationError extends Error {
  public readonly issues: z.ZodIssue[];
  constructor(zodError: z.ZodError, context: string) {
    const pretty = zodError.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    super(`BuildOutput validation failed (${context}):\n${pretty}`);
    this.name = 'BuildOutputValidationError';
    this.issues = zodError.issues;
  }
}

export function validateBuildOutput(input: unknown): BuildOutput {
  const result = BuildOutputSchema.safeParse(input);
  if (!result.success) {
    throw new BuildOutputValidationError(result.error, 'runBuildSquad output');
  }
  return result.data;
}

export function validateBuildMetadata(input: unknown): BuildMetadata {
  const result = BuildMetadataSchema.safeParse(input);
  if (!result.success) {
    throw new BuildOutputValidationError(result.error, 'BuildMetadata');
  }
  return result.data;
}

export function validateSeoTags(input: unknown): SeoTags {
  const result = SeoTagsSchema.safeParse(input);
  if (!result.success) {
    throw new BuildOutputValidationError(result.error, 'SeoTags');
  }
  return result.data;
}

// skeleton-extractor.types — SM-2.1
//
// Zod schemas + TS types pra ExtractedSourceJson, SkeletonExtractInput e
// SkeletonExtractResult. Shape estabilizado em SM-1.4 e docs/architecture
// skeleton-mode §5.1.
//
// Separado do runtime `.ts` pra evitar import cíclico com skeleton-composer
// (SM-2.4) que consome `ExtractedSourceJson` como input.

import { z } from 'zod';

// ─── Copy ────────────────────────────────────────────────────────────────────

export const CopyFaqItemSchema = z.object({
  q: z.string(),
  a: z.string(),
});

export const CopyTestimonialSchema = z.object({
  author: z.string(),
  content: z.string(),
});

export const CopySchema = z.object({
  hero_headline: z.string(),
  hero_subhead: z.string().optional(),
  benefit_bullets: z.array(z.string()).default([]),
  faq: z.array(CopyFaqItemSchema).default([]),
  testimonials: z.array(CopyTestimonialSchema).default([]),
});

// ─── Imagery ─────────────────────────────────────────────────────────────────

export const ImagerySchema = z.object({
  hero_url: z.string().nullable(),
  gallery_urls: z.array(z.string()).default([]),
  lifestyle_urls: z.array(z.string()).default([]),
  logo_url: z.string().nullable(),
});

// ─── Brand (hints) ───────────────────────────────────────────────────────────
// Populado parcialmente aqui — brand-extractor (SM-2.2) refina depois.

export const BrandSchema = z.object({
  colors_hex_candidates: z.array(z.string()).default([]),
  fonts_used: z.array(z.string()).default([]),
});

// ─── Commerce ────────────────────────────────────────────────────────────────

export const CommerceReviewSchema = z.object({
  author: z.string(),
  content: z.string(),
  rating: z.number().optional(),
});

export const CommerceBundleSchema = z.object({
  name: z.string(),
  price_cents: z.number(),
  compare_at_cents: z.number().optional(),
  qty: z.number(),
});

export const CommerceSchema = z.object({
  reviews: z.array(CommerceReviewSchema).default([]),
  bundles: z.array(CommerceBundleSchema).default([]),
  currency: z.string().nullable(),
  badges: z.array(z.string()).default([]),
});

// ─── Dynamic extras (Nível 2.5) ──────────────────────────────────────────────
// Até 3 seções extras que a fonte tem mas o skeleton fixo (12 slots) não cobre.
// Shape de `payload` depende de `kind` — validado no composer (SM-2.4).

export const DynamicExtraKindSchema = z.enum([
  'bullets',
  'story',
  'stats',
  'gallery',
  'problem_agitation',
  'solution_benefits',
  'before_after',
  'comparison',
]);

export const DynamicExtraSchema = z.object({
  kind: DynamicExtraKindSchema,
  heading: z.string(),
  payload: z.unknown(),
  llm_verdict: z.enum(['recommended', 'optional', 'skip']),
  llm_reason: z.string(),
});

// ─── Meta ────────────────────────────────────────────────────────────────────

export const DetectedLanguageSchema = z
  .enum(['de', 'it', 'en', 'es', 'fr', 'pt-BR'])
  .nullable();

export const MetaSchema = z.object({
  partial: z.boolean(),
  unresolved_fields: z.array(z.string()).default([]),
  detected_language: DetectedLanguageSchema,
});

// ─── Top-level ExtractedSourceJson ───────────────────────────────────────────

export const ExtractedSourceJsonSchema = z.object({
  copy: CopySchema,
  imagery: ImagerySchema,
  brand: BrandSchema,
  commerce: CommerceSchema,
  dynamic_extras: z.array(DynamicExtraSchema).max(3).default([]),
  meta: MetaSchema,
});

export type ExtractedSourceJson = z.infer<typeof ExtractedSourceJsonSchema>;

// ─── I/O of extractSkeleton ──────────────────────────────────────────────────

export type ThemeFingerprint =
  | 'aurivita'
  | 'bepurex'
  | 'kaching'
  | 'shopify-default'
  | 'unknown';

export type DetectedLanguage = z.infer<typeof DetectedLanguageSchema>;

export interface SkeletonExtractInput {
  url: string;
  /** FR-30 — HTML colado manualmente (fallback quando renderer falha ou site bloqueia). */
  htmlOverride?: string;
  /** Screenshot bruto (Buffer PNG) quando disponível por override. */
  screenshotOverride?: Buffer;
  targetSkeleton: 'advertorial' | 'landing';
  /** Landing UUID pra path no bucket. Opcional — se ausente usa timestamp/random. */
  landingId?: string;
  /** Uploader plugável — evita dependência hard no @supabase/supabase-js. */
  storageUploader?: SkeletonStorageUploader;
  /** Vision LLM plugável — testes mockam. Default: Gemini Vision (providers/gemini-vision). */
  visionCaller?: SkeletonVisionCaller;
  /** Se true, força modo degradado (skipa Vision) — CLI/debug. */
  disableVision?: boolean;
}

/** Provider Vision plugável — retorna JSON string com {hero_url_candidate?, dynamic_extras?, detected_language?, ...}. */
export type SkeletonVisionCaller = (opts: {
  screenshotBase64: string;
  screenshotMime: string;
  cheerioContext: string;
}) => Promise<string>;

/** Storage uploader plugável — retorna path final dentro do bucket. */
export type SkeletonStorageUploader = (opts: {
  bucket: string;
  path: string;
  bytes: Buffer;
  contentType: string;
}) => Promise<{ path: string }>;

export interface SkeletonExtractRaw {
  html: string;
  screenshotPath: string;
  finalUrl: string;
  detectedLanguage: DetectedLanguage;
}

export interface SkeletonExtractTrace {
  step: string;
  latencyMs: number;
  provider: 'playwright' | 'cheerio' | 'vision-gemini' | 'storage' | 'validation';
  notes?: string;
}

export interface SkeletonExtractResult {
  raw: SkeletonExtractRaw;
  extracted: ExtractedSourceJson;
  degradedFields: string[];
  themeFingerprint: ThemeFingerprint;
  trace: SkeletonExtractTrace[];
}

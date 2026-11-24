// skeleton-composer.types.ts — SM-2.4
//
// Tipos consumidos por `composeBepurexSlots`. `ExtractedSourceJson` é um
// stand-in enquanto SM-2.1 (skeleton-extractor) não land — o shape está
// congelado pela arquitetura (§5.1) e reflete o Zod schema que SM-2.1 vai
// exportar. Quando SM-2.1 completar, o export daqui é substituído por um
// `import type { ExtractedSourceJson } from './skeleton-extractor.types.js'`
// re-exportado — assinatura pública de `composeBepurexSlots` fica intacta.
//
// Fonte da verdade da arquitetura:
//   docs/architecture/skeleton-mode-architecture.md §5.1 (ExtractedSourceJsonSchema)
//   docs/architecture/skeleton-mode-architecture.md §5.3 (ComposeInput/ComposeResult)
//   docs/architecture/skeleton-mode-architecture.md §7  (12 slots fixos + 3 dinâmicos)

// Import direto do arquivo `types.ts` (não do barrel) porque o barrel
// re-exporta componentes .tsx e o pacote cloner não tem `jsx` habilitado.
// Types são type-only imports — zero runtime.
import type {
  BepurexSlots,
  BodySection,
} from '@blackshop/landinglab-render/templates/landinglab/types.js';

// ─── Language (v1.2 supported set) ──────────────────────────────────────────

export type SkeletonLanguage = 'de' | 'it' | 'en' | 'es' | 'fr' | 'pt-BR';

// ─── ExtractedSourceJson (mirror do schema Zod de SM-2.1) ───────────────────

export interface ExtractedCopy {
  hero_headline: string;
  hero_subhead?: string;
  benefit_bullets: string[];
  faq: Array<{ q: string; a: string }>;
  testimonials: Array<{ author: string; content: string }>;
  /** Copy livre pra "guarantee/badge" — opcional, populado por vision-classify. */
  guarantee_text?: string;
  /** Copy livre pra "urgency" — opcional. */
  urgency_text?: string;
}

export interface ExtractedImagery {
  hero_url: string | null;
  gallery_urls: string[];
  /** Fotos "lifestyle" — humanos usando produto, ambientes reais. */
  lifestyle_urls: string[];
  logo_url: string | null;
}

export interface ExtractedBrandHints {
  colors_hex_candidates: string[];
  fonts_used: string[];
}

export interface ExtractedReview {
  author: string;
  content: string;
  rating?: number;
}

export interface ExtractedBundle {
  name: string;
  price_cents: number;
  compare_at_cents?: number;
  qty: number;
}

export interface ExtractedCommerce {
  reviews: ExtractedReview[];
  bundles: ExtractedBundle[];
  currency: string | null;
  badges: string[];
}

/** BodySection kinds que o skeleton composer aceita como dynamic extra (subset). */
export type DynamicExtraKind =
  | 'bullets'
  | 'story'
  | 'stats'
  | 'gallery'
  | 'problem_agitation'
  | 'solution_benefits'
  | 'before_after'
  | 'comparison';

export interface ExtractedDynamicExtra {
  kind: DynamicExtraKind;
  heading: string;
  /** Shape depende de kind — validado quando o composer constrói a BodySection. */
  payload: unknown;
  llm_verdict: 'recommended' | 'optional' | 'skip';
  llm_reason: string;
}

export interface ExtractedMeta {
  partial: boolean;
  unresolved_fields: string[];
  detected_language: SkeletonLanguage | null;
}

export interface ExtractedSourceJson {
  copy: ExtractedCopy;
  imagery: ExtractedImagery;
  brand: ExtractedBrandHints;
  commerce: ExtractedCommerce;
  /** Max 3 no schema. Composer refiltra por verdict + limita a 3. */
  dynamic_extras: ExtractedDynamicExtra[];
  meta: ExtractedMeta;
}

// ─── Optional post-hoc enrichment (absorve SM-5.5) ──────────────────────────
//
// `copyDeck?` e `visualAssets?` são hooks pra quando o pipeline enriquece a
// composição com output de copy-chief (re-audit) ou visual-director (lifestyle
// augment) DEPOIS da extração inicial. Se ausentes, composer usa apenas
// `extracted` + `brand`. Isso absorve SM-5.5 sem duplicar a lógica em
// `packages/landinglab-build/src/agents/content-composer.ts`.
//
// Shapes intencionalmente MÍNIMOS — não puxamos dependências de @blackshop/
// landinglab-copy nem @blackshop/landinglab-visual aqui pra evitar acoplamento
// upstream. Callers do build package podem adaptar os shapes ricos deles pra
// esses parciais no ponto de chamada.

export interface CopyDeckOverride {
  /** Substitui `extracted.copy.hero_headline` quando presente. */
  hero_headline?: string;
  /** Substitui `extracted.copy.hero_subhead` quando presente. */
  hero_subhead?: string;
  /** Substitui `extracted.copy.benefit_bullets` quando não-vazio. */
  benefit_bullets?: string[];
  /** Substitui `extracted.copy.faq` quando não-vazio. */
  faq?: Array<{ q: string; a: string }>;
  /** Copy pra guarantee (fallback: extracted.copy.guarantee_text OR default i18n). */
  guarantee?: string;
  /** Copy pra urgency (fallback: extracted.copy.urgency_text). */
  urgency?: string;
  /** CTA primário — substitui default gerado do primeiro badge. */
  cta_primary_text?: string;
}

export interface VisualAssetsOverride {
  /** Substitui `extracted.imagery.hero_url` quando presente. */
  hero_url?: string;
  hero_srcset?: { mobile?: string; og?: string; desktop?: string };
  /** Concatena com `extracted.imagery.gallery_urls`. */
  extra_gallery_urls?: string[];
  /** Concatena com `extracted.imagery.lifestyle_urls`. */
  extra_lifestyle_urls?: string[];
  /** Trust badge URLs (não confundir com badges de texto do commerce). */
  trust_badge_urls?: string[];
  /** URLs before/after (visual comparison). */
  before_after_urls?: string[];
}

// ─── Compose input/output (arquitetura §5.3) ────────────────────────────────

export type SkeletonId = 'bepurex-advertorial-v1' | 'bepurex-landing-v1';

export interface ComposeInput {
  extracted: ExtractedSourceJson;
  /** Precisa dos campos que o composer usa — mas aceita superset. */
  brand: BrandLike;
  targetSkeleton: SkeletonId;
  language: SkeletonLanguage;
  /** Nome do produto (usado em prompt de reviews IA). Fallback: brand name/title. */
  productName?: string;
  /** Enrichment opcional pós-extração (absorve SM-5.5). */
  copyDeck?: CopyDeckOverride;
  visualAssets?: VisualAssetsOverride;
}

/** Shape mínimo do BrandExtractResult que o composer consome — evita import
 *  circular no futuro caso brand-extractor importe tipos do composer. */
export interface BrandLike {
  primary: string;
  secondary: string;
  accent: string;
  bg: string;
  text: string;
  headline_font: string;
  body_font: string;
  logo_url: string | null;
  logo_source: 'extracted_from_fonte' | 'not_found';
}

export interface DynamicExtraStatus {
  kind: BodySection['kind'];
  heading: string;
  slot_index: 0 | 1 | 2;
  llm_verdict: 'recommended' | 'optional' | 'skip';
  approved: boolean;
}

export type LogoSource =
  | 'extracted_from_fonte'
  | 'generated_brand_forge'
  | 'manual_upload'
  | 'none';

export interface LogoDecision {
  used_logo_url: string | null;
  source: LogoSource;
}

export interface ComposeResult {
  slots: BepurexSlots;
  dynamicExtrasStatus: DynamicExtraStatus[];
  aiGeneratedReviewsCount: number;
  logoDecision: LogoDecision;
}

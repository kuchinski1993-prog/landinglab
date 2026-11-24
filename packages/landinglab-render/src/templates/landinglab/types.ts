// Template Slots — shared shape consumed by all 3 landinglab templates.
//
// Story 13.6 AC17. Content Composer (packages/landinglab-build/src/agents/
// content-composer.ts) is responsible for mapping CopyDeck + VisualAssets into
// this shape; templates render it as HTML via React SSR.
//
// Design decisions:
// - All arrays default to empty (never undefined) to make templates lenient.
// - `image_url` fields are always required strings (composer supplies a placeholder
//   when the visual bundle is missing an asset).
// - `bodySections` is a discriminated union — templates render only the kinds they
//   support and ignore the rest (short-form-direct ignores 'faq', 'story', etc).
// - `brand.palette` maps 1:1 to CSS custom properties injected by html-builder.

export interface BrandSlot {
  name: string;
  tagline: string;
  logo_url: string;
  palette: {
    primary: string;
    secondary: string;
    accent: string;
    bg: string;
    text: string;
  };
  typography: {
    headline_font: string;
    body_font: string;
  };
}

export interface HeroSlot {
  headline: string;
  subhead: string;
  image_url: string;
  /** Extra sizes for srcset (populated by performance-optimizer, not composer). */
  image_srcset?: { mobile?: string; og?: string; desktop?: string };
  cta_primary: CtaSlot;
}

export interface CtaSlot {
  text: string;
  variant?: 'a' | 'b' | 'c';
  urgency_type?: 'scarcity' | 'time_limited' | 'social_proof' | 'authority';
}

export interface BulletSlot {
  text: string;
  icon_url?: string;
}

export interface FaqSlot {
  question: string;
  answer: string;
}

export interface TestimonialSlot {
  content: string;
  source?: string;
}

export interface ComparisonRow {
  feature: string;
  ours: string;
  theirs: string;
}

// ─── Discriminated body section union ─────────────────────────────────────

export type BodySection =
  | { kind: 'bullets'; heading: string; items: BulletSlot[] }
  | { kind: 'story'; heading: string; paragraphs: string[]; image_url?: string }
  | { kind: 'comparison'; heading: string; rows: ComparisonRow[] }
  | { kind: 'stats'; heading: string; items: Array<{ label: string; value: string }> }
  | { kind: 'testimonials'; heading: string; items: TestimonialSlot[] }
  | { kind: 'faq'; heading: string; items: FaqSlot[] }
  | { kind: 'guarantee'; heading: string; body: string }
  | { kind: 'urgency'; heading: string; body: string }
  // Fase 3 do redesign: novos blocos pra páginas de venda de alta conversão.
  // before_after: comparação visual antes/depois (imagens + labels).
  | {
      kind: 'before_after';
      heading: string;
      before: { image_url: string; label: string };
      after: { image_url: string; label: string };
    }
  // problem_agitation: identificação da dor + agitação emocional. Formato
  // "pain-first" pra criar tensão antes da solução (Schwartz awareness low).
  | { kind: 'problem_agitation'; heading: string; paragraphs: string[] }
  // solution_benefits: 3-5 bullets explicando COMO o produto resolve. Diferente
  // de `bullets` genérico — este é sempre benefit-driven pós-problem.
  | { kind: 'solution_benefits'; heading: string; benefits: BulletSlot[] }
  // gallery: linha ou grid de imagens do produto (mediaUrls do Firecrawl).
  // Não é hero (grande), é gallery (secundário). Vai bem depois do offer.
  | { kind: 'gallery'; heading: string; image_urls: string[] };

// ─── Offer stack ──────────────────────────────────────────────────────────

export interface OfferBonusSlot {
  name: string;
  perceived_value: string;
  description: string;
}

export interface OfferStackSlot {
  core: string;
  bonuses: OfferBonusSlot[];
  total_value: string;
  actual_price: string;
  savings: string;
  guarantee: string;
}

// ─── Social proof aggregate ───────────────────────────────────────────────

export interface SocialProofSlot {
  testimonials_content: TestimonialSlot[];
  badges_urls: string[];
  before_after_urls: string[];
}

// ─── Top-level TemplateSlots ──────────────────────────────────────────────

export interface TemplateSlots {
  language: string;
  brand: BrandSlot;
  hero: HeroSlot;
  body_sections: BodySection[];
  offer_stack: OfferStackSlot;
  ctas: {
    primary: CtaSlot;
    secondary?: CtaSlot;
    tertiary?: CtaSlot;
  };
  trust_badges: Array<{ url: string; alt: string }>;
  social_proof: SocialProofSlot;
  /** Sticky CTA opcional — quando presente, fica fixo no rodapé mobile. */
  sticky_cta?: {
    text: string;
    price_hint?: string; // ex: "EUR 69,95 · frete grátis"
  };
}

// ─── Bepurex Skeleton Slots (SM-1.4, FR-7/FR-8) ───────────────────────────
// Shape 1:1 com LandinglabBundleSlot (landinglab-cloner) — replicado pra evitar
// dependência cruzada render↔cloner.
export interface BundleDisplaySlot {
  name: string;
  description?: string;
  priceCents: number;
  compareAtPriceCents: number | null;
  quantityUnits: number | null;
  highlight?: 'popular' | 'best' | null;
}

export interface BepurexSlots extends TemplateSlots {
  /** 0-3 BodySection aprovadas pelo dono (FR-7). */
  dynamic_extras: BodySection[];
  timeline?: {
    heading: string;
    steps: Array<{ label: string; description: string }>;
  };
  doctors_endorsement?: {
    heading: string;
    body: string;
    author: string;
    credentials: string;
  };
  bundle_slots?: BundleDisplaySlot[];
}

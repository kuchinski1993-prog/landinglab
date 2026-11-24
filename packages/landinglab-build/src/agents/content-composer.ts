// Content Composer — deterministic mapping of CopyDeck + VisualAssets into TemplateSlots.
//
// Story 13.6 AC11. Pure function. No LLM. Robust to missing blocks (never throws
// on absent optional data — templates render only what they have).
//
// Key mappings:
//   VisualAssets.brand           → TemplateSlots.brand
//   CopyDeck.hooks[0]            → hero.headline
//   CopyDeck.subheadlines[0]     → hero.subhead
//   VisualAssets.hero.desktop    → hero.image_url (fallback og || mobile)
//   CopyDeck.ctas[]              → { primary, secondary?, tertiary? }
//   CopyDeck.benefit_bullets     → body_sections (kind='bullets') with icons interspersed
//   CopyDeck.faq                 → body_sections (kind='faq')
//   CopyDeck.offer_stack         → OfferStackSlot (Hormozi shape → template shape)
//   CopyDeck.guarantee           → body_sections (kind='guarantee')
//   CopyDeck.urgency_copy        → body_sections (kind='urgency')
//   CopyDeck.social_proof_blocks → social_proof + trust_badges

import type { CopyDeck } from '@blackshop/landinglab-copy';
import type { VisualAssets } from '@blackshop/landinglab-visual';
import type {
  BepurexSlots,
  BodySection,
  BundleDisplaySlot,
  BulletSlot,
  CtaSlot,
  FaqSlot,
  OfferStackSlot,
  SocialProofSlot,
  TemplateSlots,
  TestimonialSlot,
} from '@blackshop/landinglab-render/templates/landinglab';

import type { TemplateName } from '../schema/build-output.js';

export interface ComposeSlotsInput {
  copyDeck: CopyDeck;
  visualAssets: VisualAssets;
  templateName: TemplateName;
  language?: string;
}

export function composeSlots(input: ComposeSlotsInput): TemplateSlots {
  const { copyDeck, visualAssets, templateName } = input;
  const language = input.language ?? copyDeck.language ?? 'en';

  // ─── Brand ────────────────────────────────────────────────────────────
  const logo =
    visualAssets.brand.logo_urls.full ||
    visualAssets.brand.logo_urls.mark ||
    visualAssets.brand.logo_urls.wordmark ||
    '';

  const brandSlot = {
    name: visualAssets.brand.name,
    tagline: visualAssets.brand.tagline,
    logo_url: logo,
    palette: visualAssets.brand.palette,
    typography: visualAssets.brand.typography,
  };

  // ─── Hero image (desktop → og → mobile fallback chain) ────────────────
  const heroUrls = visualAssets.assets.hero.urls_by_size;
  const heroImage = heroUrls.desktop || heroUrls.og || heroUrls.mobile || '';

  // ─── CTAs (variant a/b/c mapped to primary/secondary/tertiary) ────────
  const [ctaA, ctaB, ctaC] = copyDeck.ctas;
  const primaryCta: CtaSlot = ctaA
    ? {
        text: ctaA.text,
        variant: ctaA.variant,
        urgency_type: ctaA.urgency_type,
      }
    : { text: 'Get started', variant: 'a', urgency_type: 'time_limited' };
  const secondaryCta: CtaSlot | undefined = ctaB
    ? { text: ctaB.text, variant: ctaB.variant, urgency_type: ctaB.urgency_type }
    : undefined;
  const tertiaryCta: CtaSlot | undefined = ctaC
    ? { text: ctaC.text, variant: ctaC.variant, urgency_type: ctaC.urgency_type }
    : undefined;

  // ─── Hero slot ────────────────────────────────────────────────────────
  const headline = copyDeck.hooks[0]?.text ?? brandSlot.tagline;
  const subhead = copyDeck.subheadlines[0] ?? brandSlot.tagline;

  const heroSlot = {
    headline,
    subhead,
    image_url: heroImage,
    image_srcset: {
      mobile: heroUrls.mobile || undefined,
      og: heroUrls.og || undefined,
      desktop: heroUrls.desktop || undefined,
    },
    cta_primary: primaryCta,
  };

  // ─── Bullets (with icons interspersed by matches_bullet index) ─────────
  const bulletItems: BulletSlot[] = copyDeck.benefit_bullets.map((b, idx) => {
    const icon = visualAssets.assets.icons.find((i) => i.matches_bullet === idx);
    const bullet: BulletSlot = { text: b.text };
    if (icon?.url) bullet.icon_url = icon.url;
    return bullet;
  });

  // ─── FAQ ──────────────────────────────────────────────────────────────
  const faqItems: FaqSlot[] = copyDeck.faq.map((f) => ({
    question: f.question,
    answer: f.answer,
  }));

  // ─── Body sections (composer emits ALL relevant kinds; templates filter) ─
  const bodySections: BodySection[] = [];

  if (bulletItems.length > 0) {
    bodySections.push({
      kind: 'bullets',
      heading: 'What you get',
      items: bulletItems,
    });
  }

  if (faqItems.length > 0) {
    bodySections.push({
      kind: 'faq',
      heading: 'Frequently asked questions',
      items: faqItems,
    });
  }

  if (copyDeck.guarantee) {
    bodySections.push({
      kind: 'guarantee',
      heading: 'Our guarantee',
      body: copyDeck.guarantee,
    });
  }

  if (copyDeck.urgency_copy) {
    bodySections.push({
      kind: 'urgency',
      heading: 'Act now',
      body: copyDeck.urgency_copy,
    });
  }

  // Story-driven and long-form both use a 'story' section. Derive from
  // top pain verbatim + subheadline if available. Only add if we have material.
  const topPain = copyDeck.voc_verbatim_used?.[0];
  const topSubhead = copyDeck.subheadlines[1] ?? copyDeck.subheadlines[0];
  if (templateName !== 'short-form-direct' && (topPain || topSubhead)) {
    const paragraphs = [topPain, topSubhead].filter((p): p is string => !!p);
    if (paragraphs.length > 0) {
      bodySections.push({
        kind: 'story',
        heading: 'Why we built this',
        paragraphs,
      });
    }
  }

  // Stats derived from social_proof_blocks with type='stat'.
  const statBlocks = copyDeck.social_proof_blocks.filter((s) => s.type === 'stat');
  if (statBlocks.length > 0 && templateName === 'long-form-advertorial') {
    bodySections.push({
      kind: 'stats',
      heading: 'By the numbers',
      items: statBlocks.map((s) => ({
        label: s.source ?? 'proof',
        value: s.content,
      })),
    });
  }

  // ─── Offer stack ──────────────────────────────────────────────────────
  const offerStackSlot: OfferStackSlot = {
    core: copyDeck.offer_stack.main_offer,
    bonuses: copyDeck.offer_stack.bonuses.map((b) => ({
      name: b.name,
      perceived_value: b.perceived_value,
      description: b.description,
    })),
    total_value: copyDeck.offer_stack.real_value_stack,
    actual_price: copyDeck.offer_stack.price_anchor,
    savings: copyDeck.offer_stack.real_value_stack,
    guarantee: copyDeck.offer_stack.guarantee,
  };

  // ─── Social proof aggregate ───────────────────────────────────────────
  const testimonialContent: TestimonialSlot[] = copyDeck.social_proof_blocks
    .filter((s) => s.type === 'review' || s.type === 'authority')
    .map((s) => ({
      content: s.content,
      source: s.source ?? undefined,
    }));

  const socialProofSlot: SocialProofSlot = {
    testimonials_content: testimonialContent,
    badges_urls: visualAssets.assets.trust_badges,
    before_after_urls: visualAssets.assets.before_after ?? [],
  };

  // ─── Trust badges (with alt text) ─────────────────────────────────────
  const trustBadges = visualAssets.assets.trust_badges.map((url, i) => ({
    url,
    alt: `Trust badge ${i + 1}`,
  }));

  return {
    language,
    brand: brandSlot,
    hero: heroSlot,
    body_sections: bodySections,
    offer_stack: offerStackSlot,
    ctas: {
      primary: primaryCta,
      ...(secondaryCta ? { secondary: secondaryCta } : {}),
      ...(tertiaryCta ? { tertiary: tertiaryCta } : {}),
    },
    trust_badges: trustBadges,
    social_proof: socialProofSlot,
  };
}

// ─── Skeleton Mode — composeBepurexSlots (SM-5.5) ─────────────────────────
//
// Pure sync mapping from `ExtractedSourceJson` + `BrandExtractResult` (+ optional
// `CopyDeck` / `VisualAssets`) into `BepurexSlots`. Serves the landinglab-build
// pipeline for skeleton-mode landings.
//
// This function is INDEPENDENT of `composeSlots()` above — zero shared branches,
// zero regression risk on Autopilot's flow. Reviews IA (FR-10) is NOT handled
// here (that's `skeleton-composer.ts` in landinglab-cloner — SM-2.4). Here we
// treat missing reviews as "empty testimonials array" — the caller decides
// whether to invoke the LLM.
//
// Input shape is defined STRUCTURALLY (interfaces below) to avoid a circular
// dependency landinglab-build ↔ landinglab-cloner. The canonical `ExtractedSourceJson`
// Zod schema lives in landinglab-cloner (SM-2.1); this shape is a subset that
// tolerates the fields we consume. TypeScript structural typing makes both
// compatible when SM-2.1 completes.
//
// Fallback strategy per §7 (12 Slots Fixos) of skeleton-mode-architecture.md:
//   - Missing hero image → placeholder cinza URL
//   - Missing bundle → single-slot fallback from `extracted.commerce`
//   - Missing FAQ/testimonials → section omitted (empty arrays)
//   - Missing guarantee → default "30-day money-back guarantee" (i18n via language)

// Structural inputs — subset of ExtractedSourceJson (SM-2.1) and BrandExtractResult (SM-2.2).
// Kept minimal: composer only reads what it maps. Full types live in landinglab-cloner.

export interface ExtractedCommerceReview {
  author: string;
  content: string;
  rating?: number;
}

export interface ExtractedCommerceBundle {
  name: string;
  price_cents: number;
  compare_at_cents?: number | null;
  qty: number;
}

export interface ExtractedFaqItem {
  q: string;
  a: string;
}

export interface ExtractedTestimonial {
  author: string;
  content: string;
}

export interface ExtractedDynamicExtra {
  kind: BodySection['kind'];
  heading: string;
  payload: unknown;
  llm_verdict: 'recommended' | 'optional' | 'skip';
  llm_reason?: string;
}

export interface ExtractedSourceLike {
  copy: {
    hero_headline: string;
    hero_subhead?: string;
    benefit_bullets?: string[];
    faq?: ExtractedFaqItem[];
    testimonials?: ExtractedTestimonial[];
    guarantee?: string;
  };
  imagery: {
    hero_url: string | null;
    gallery_urls?: string[];
    lifestyle_urls?: string[];
    logo_url: string | null;
  };
  commerce: {
    reviews?: ExtractedCommerceReview[];
    bundles?: ExtractedCommerceBundle[];
    currency: string | null;
    badges?: string[];
  };
  dynamic_extras?: ExtractedDynamicExtra[];
  meta?: {
    detected_language?: string | null;
  };
}

export interface BrandExtractLike {
  primary: string;
  secondary: string;
  accent: string;
  bg: string;
  text: string;
  headline_font: string;
  body_font: string;
  logo_url: string | null;
}

export interface ComposeBepurexSlotsInput {
  extracted: ExtractedSourceLike;
  brand: BrandExtractLike;
  /** Optional copy augmentation (from copy-chief audit) — overrides extracted copy when present. */
  copyDeck?: CopyDeck;
  /** Optional visual augmentation (from visual-director) — supplies trust badges + before/after. */
  visualAssets?: VisualAssets;
  /** BCP-47 language tag; defaults to extracted.meta.detected_language, then 'en'. */
  language?: string;
}

// Default fallback constants — sourced from §7 (12 Slots Fixos) of the architecture doc.
const PLACEHOLDER_IMAGE_URL = 'https://placehold.co/1200x800/cccccc/333333?text=Configure+na+edição';
const FALLBACK_HEADLINE = 'Configure na edição';
const FALLBACK_CTA_TEXT = 'Compre agora';
const FALLBACK_GUARANTEE_BY_LANG: Record<string, string> = {
  en: '30-day money-back guarantee',
  'pt-BR': 'Garantia de 30 dias ou seu dinheiro de volta',
  pt: 'Garantia de 30 dias ou seu dinheiro de volta',
  es: 'Garantía de devolución del dinero de 30 días',
  it: 'Garanzia soddisfatti o rimborsati entro 30 giorni',
  de: '30-Tage-Geld-zurück-Garantie',
  fr: 'Garantie satisfait ou remboursé de 30 jours',
};

function pickGuarantee(language: string, extracted: string | undefined): string {
  if (extracted && extracted.trim().length > 0) return extracted;
  return FALLBACK_GUARANTEE_BY_LANG[language] ?? FALLBACK_GUARANTEE_BY_LANG.en!;
}

function formatPriceCents(cents: number, currency: string | null): string {
  const amount = (cents / 100).toFixed(2);
  return currency ? `${currency} ${amount}` : amount;
}

function buildFallbackBundles(
  commerce: ExtractedSourceLike['commerce'],
): BundleDisplaySlot[] {
  const bundles = commerce.bundles ?? [];
  if (bundles.length > 0) {
    return bundles.map((b) => ({
      name: b.name,
      priceCents: b.price_cents,
      compareAtPriceCents: b.compare_at_cents ?? null,
      quantityUnits: b.qty,
      highlight: null,
    }));
  }
  // Fallback single-slot bundle when extraction found none (§7 slot 8).
  return [
    {
      name: '1 unit',
      priceCents: 0,
      compareAtPriceCents: null,
      quantityUnits: 1,
      highlight: null,
    },
  ];
}

function pickDynamicExtras(extras: ExtractedDynamicExtra[]): BodySection[] {
  // Filter by verdict: recommended first, then optional. Cap at 3. Skip 'skip'.
  const recommended = extras.filter((e) => e.llm_verdict === 'recommended');
  const optional = extras.filter((e) => e.llm_verdict === 'optional');
  const ordered = [...recommended, ...optional].slice(0, 3);

  return ordered.map((extra) => {
    // The `payload` is `unknown` at the extraction layer — we trust the verdict
    // and hand it to the template's discriminated union via a `kind`-tagged
    // structural cast. Templates render only kinds they support and ignore rest.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { kind: extra.kind, heading: extra.heading, ...(extra.payload as any) } as BodySection;
  });
}

export function composeBepurexSlots(input: ComposeBepurexSlotsInput): BepurexSlots {
  const { extracted, brand, copyDeck, visualAssets } = input;
  const language = input.language ?? extracted.meta?.detected_language ?? copyDeck?.language ?? 'en';

  // ─── Slot 1: brand.logo (fallback = placeholder) ──────────────────────
  const logoUrl =
    brand.logo_url ??
    extracted.imagery.logo_url ??
    (visualAssets?.brand.logo_urls.full ||
      visualAssets?.brand.logo_urls.mark ||
      visualAssets?.brand.logo_urls.wordmark ||
      '');

  // ─── Slots 2/3: brand.palette + typography (already normalized by brand-extractor) ─
  const brandSlot = {
    name: visualAssets?.brand.name ?? copyDeck?.hooks[0]?.text ?? '',
    tagline: visualAssets?.brand.tagline ?? copyDeck?.subheadlines[0] ?? '',
    logo_url: logoUrl,
    palette: {
      primary: brand.primary,
      secondary: brand.secondary,
      accent: brand.accent,
      bg: brand.bg,
      text: brand.text,
    },
    typography: {
      headline_font: brand.headline_font,
      body_font: brand.body_font,
    },
  };

  // ─── Slot 4/5/6: hero (headline, subhead, image) ──────────────────────
  const heroHeadline =
    copyDeck?.hooks[0]?.text ?? extracted.copy.hero_headline ?? FALLBACK_HEADLINE;
  const heroSubhead =
    copyDeck?.subheadlines[0] ?? extracted.copy.hero_subhead ?? '';
  const heroImage =
    extracted.imagery.hero_url ??
    extracted.imagery.gallery_urls?.[0] ??
    visualAssets?.assets.hero.urls_by_size.desktop ??
    PLACEHOLDER_IMAGE_URL;

  // ─── CTAs (fallback single primary if copyDeck absent) ────────────────
  const [ctaA, ctaB, ctaC] = copyDeck?.ctas ?? [];
  const primaryCta: CtaSlot = ctaA
    ? { text: ctaA.text, variant: ctaA.variant, urgency_type: ctaA.urgency_type }
    : { text: FALLBACK_CTA_TEXT, variant: 'a', urgency_type: 'time_limited' };
  const secondaryCta: CtaSlot | undefined = ctaB
    ? { text: ctaB.text, variant: ctaB.variant, urgency_type: ctaB.urgency_type }
    : undefined;
  const tertiaryCta: CtaSlot | undefined = ctaC
    ? { text: ctaC.text, variant: ctaC.variant, urgency_type: ctaC.urgency_type }
    : undefined;

  const heroSlot = {
    headline: heroHeadline,
    subhead: heroSubhead,
    image_url: heroImage,
    cta_primary: primaryCta,
  };

  // ─── Slot 7: benefit_bullets (from extracted or copyDeck) ─────────────
  const rawBullets = extracted.copy.benefit_bullets ?? [];
  const bulletItems: BulletSlot[] = rawBullets.map((text) => ({ text }));

  // ─── Slot 8: bundle_slots ──────────────────────────────────────────────
  const bundleSlots = buildFallbackBundles(extracted.commerce);

  // ─── Slot 9: testimonials (from extracted; template omits if empty) ───
  const testimonialItems: TestimonialSlot[] = (extracted.copy.testimonials ?? []).map((t) => ({
    content: t.content,
    source: t.author,
  }));

  // ─── Slot 10: faq ─────────────────────────────────────────────────────
  const faqItems: FaqSlot[] = (extracted.copy.faq ?? []).map((f) => ({
    question: f.q,
    answer: f.a,
  }));

  // ─── Slot 11: guarantee (i18n fallback) ───────────────────────────────
  const guaranteeText = pickGuarantee(language, extracted.copy.guarantee);

  // ─── Body sections (12 slots orchestration) ───────────────────────────
  const bodySections: BodySection[] = [];
  if (bulletItems.length > 0) {
    bodySections.push({ kind: 'bullets', heading: 'Benefits', items: bulletItems });
  }
  if (testimonialItems.length > 0) {
    bodySections.push({ kind: 'testimonials', heading: 'What customers say', items: testimonialItems });
  }
  if (faqItems.length > 0) {
    bodySections.push({ kind: 'faq', heading: 'Frequently asked', items: faqItems });
  }
  bodySections.push({ kind: 'guarantee', heading: 'Our guarantee', body: guaranteeText });

  // ─── Offer stack (minimal — real values come from copyDeck if present) ─
  const offerStackSlot: OfferStackSlot = copyDeck
    ? {
        core: copyDeck.offer_stack.main_offer,
        bonuses: copyDeck.offer_stack.bonuses.map((b) => ({
          name: b.name,
          perceived_value: b.perceived_value,
          description: b.description,
        })),
        total_value: copyDeck.offer_stack.real_value_stack,
        actual_price: copyDeck.offer_stack.price_anchor,
        savings: copyDeck.offer_stack.real_value_stack,
        guarantee: copyDeck.offer_stack.guarantee,
      }
    : {
        core: heroHeadline,
        bonuses: [],
        total_value: '',
        actual_price:
          bundleSlots[0] && bundleSlots[0].priceCents > 0
            ? formatPriceCents(bundleSlots[0].priceCents, extracted.commerce.currency)
            : '',
        savings: '',
        guarantee: guaranteeText,
      };

  // ─── Trust badges + social proof aggregate ─────────────────────────────
  const trustBadges = (visualAssets?.assets.trust_badges ?? extracted.commerce.badges ?? []).map(
    (url, i) => ({ url, alt: `Trust badge ${i + 1}` }),
  );

  const socialProofSlot: SocialProofSlot = {
    testimonials_content: testimonialItems,
    badges_urls: visualAssets?.assets.trust_badges ?? extracted.commerce.badges ?? [],
    before_after_urls: visualAssets?.assets.before_after ?? [],
  };

  // ─── Slot 12: sticky_cta (auto from primary CTA + smallest bundle price) ─
  const smallestPricedBundle = bundleSlots
    .filter((b) => b.priceCents > 0)
    .sort((a, b) => a.priceCents - b.priceCents)[0];
  const stickyCta = {
    text: primaryCta.text,
    ...(smallestPricedBundle
      ? { price_hint: formatPriceCents(smallestPricedBundle.priceCents, extracted.commerce.currency) }
      : {}),
  };

  // ─── Dynamic extras (Level 2.5) ────────────────────────────────────────
  const dynamicExtras = pickDynamicExtras(extracted.dynamic_extras ?? []);

  const slots: BepurexSlots = {
    language,
    brand: brandSlot,
    hero: heroSlot,
    body_sections: bodySections,
    dynamic_extras: dynamicExtras,
    offer_stack: offerStackSlot,
    ctas: {
      primary: primaryCta,
      ...(secondaryCta ? { secondary: secondaryCta } : {}),
      ...(tertiaryCta ? { tertiary: tertiaryCta } : {}),
    },
    trust_badges: trustBadges,
    social_proof: socialProofSlot,
    sticky_cta: stickyCta,
    bundle_slots: bundleSlots,
  };

  return slots;
}

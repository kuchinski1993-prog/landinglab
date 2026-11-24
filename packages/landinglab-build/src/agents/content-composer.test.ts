// Story 13.6 AC28 (Wave 2) — Content Composer mapping tests.
// SM-5.5 — composeBepurexSlots tests appended at the bottom.

import { describe, expect, it } from 'vitest';
import type { CopyDeck } from '@blackshop/landinglab-copy';
import type { VisualAssets } from '@blackshop/landinglab-visual';

import {
  composeSlots,
  composeBepurexSlots,
  type BrandExtractLike,
  type ExtractedSourceLike,
} from './content-composer.js';

function makeCopyDeck(overrides: Partial<CopyDeck> = {}): CopyDeck {
  return {
    schema_version: '1.0.0',
    language: 'en',
    hooks: [
      { text: 'The one thing everyone forgets about hydration is timing.', awareness_stage: 'unaware', framework_source: 'schwartz' },
      { text: 'You are losing 3 hours of energy every single day.', awareness_stage: 'problem_aware', framework_source: 'hormozi' },
      { text: 'Join 12,000 wellness pros using HydroGlow today.', awareness_stage: 'most_aware', framework_source: 'cialdini' },
    ],
    subheadlines: ['Made from 100% recycled materials worldwide.', 'Ships in 3 business days worldwide.'],
    benefit_bullets: [
      { text: 'Keeps drinks cold for 24 hours guaranteed always.', desire_addressed: 'refresh' },
      { text: 'BPA-free, dishwasher-safe, lifetime warranty attached.', desire_addressed: 'safety' },
      { text: 'Lightweight design fits any car cup holder easily.', desire_addressed: 'convenience' },
      { text: 'Leak-proof lid with one-hand operation button design.', desire_addressed: 'ease' },
      { text: 'Save the planet with every single sip you take.', desire_addressed: 'purpose' },
    ],
    ctas: [
      { text: 'Get Yours Now', variant: 'a', urgency_type: 'time_limited' },
      { text: 'Order Today', variant: 'b', urgency_type: 'scarcity' },
      { text: 'Join Now', variant: 'c', urgency_type: 'social_proof' },
    ],
    faq: [
      { question: 'How long is shipping?', answer: 'Ships in 3-5 business days worldwide.', objection_addressed: 'time' },
      { question: 'Is there a warranty?', answer: 'Yes lifetime warranty against defects.', objection_addressed: 'quality' },
      { question: 'Can I return?', answer: 'Yes 30-day money-back guarantee.', objection_addressed: 'risk' },
      { question: 'Is it BPA-free?', answer: 'Yes all our bottles are BPA-free food-safe.', objection_addressed: 'safety' },
      { question: 'How to clean?', answer: 'Dishwasher-safe on the top rack always.', objection_addressed: 'convenience' },
    ],
    offer_stack: {
      main_offer: 'HydroGlow Bottle',
      bonuses: [{ name: 'Sleeve', perceived_value: '$19', description: 'Neoprene cup sleeve' }],
      guarantee: '30-day money-back',
      price_anchor: 'Was $79',
      real_value_stack: '$200 total value',
    },
    guarantee: 'Try HydroGlow for 30 days — if you do not love it, we refund every penny back to you.',
    urgency_copy: 'Only 47 left in stock today at this price point. Restock is 3 weeks away.',
    social_proof_blocks: [
      { type: 'stat', content: '12,000 five-star reviews' },
      { type: 'review', content: 'Best bottle ever', source: 'Amazon verified' },
    ],
    voc_verbatim_used: ['keeps me hydrated', 'love the sleek design', 'sturdy and light'],
    contributing_agents: [],
    ...overrides,
  };
}

function makeVisualAssets(overrides: Partial<VisualAssets> = {}): VisualAssets {
  return {
    schema_version: '1.0.0',
    brand: {
      name: 'HydroGlow',
      tagline: 'Design your everyday brilliance',
      logo_urls: {
        full: 'https://cdn.example.com/logo-full.png',
        mark: 'https://cdn.example.com/logo-mark.png',
        wordmark: 'https://cdn.example.com/logo-word.png',
      },
      palette: {
        primary: '#FF5A3C',
        secondary: '#FFB800',
        accent: '#00C2A8',
        bg: '#FFFFFF',
        text: '#111111',
      },
      typography: { headline_font: 'Poppins', body_font: 'Inter' },
    },
    assets: {
      hero: {
        urls_by_size: {
          desktop: 'https://cdn.example.com/hero-desktop.png',
          og: 'https://cdn.example.com/hero-og.png',
          mobile: 'https://cdn.example.com/hero-mobile.png',
        },
      },
      lifestyle: [
        'https://cdn.example.com/l1.png',
        'https://cdn.example.com/l2.png',
        'https://cdn.example.com/l3.png',
      ],
      icons: [
        { url: 'https://cdn.example.com/i1.png', matches_bullet: 0 },
        { url: 'https://cdn.example.com/i2.png', matches_bullet: 1 },
        { url: 'https://cdn.example.com/i3.png', matches_bullet: 2 },
        { url: 'https://cdn.example.com/i4.png', matches_bullet: 3 },
        { url: 'https://cdn.example.com/i5.png', matches_bullet: 4 },
      ],
      trust_badges: [
        'https://cdn.example.com/badge1.png',
        'https://cdn.example.com/badge2.png',
      ],
    },
    contributing_agents: [],
    director_notes: 'test-only director notes for composer input fixtures',
    ...overrides,
  };
}

describe('composeSlots — happy path', () => {
  it('maps all slots with a full CopyDeck + VisualAssets', () => {
    const slots = composeSlots({
      copyDeck: makeCopyDeck(),
      visualAssets: makeVisualAssets(),
      templateName: 'long-form-advertorial',
    });

    expect(slots.brand.name).toBe('HydroGlow');
    expect(slots.brand.logo_url).toBe('https://cdn.example.com/logo-full.png');
    expect(slots.hero.headline).toContain('hydration');
    expect(slots.hero.subhead).toContain('recycled');
    expect(slots.hero.image_url).toBe('https://cdn.example.com/hero-desktop.png');
    expect(slots.ctas.primary.text).toBe('Get Yours Now');
    expect(slots.ctas.secondary?.text).toBe('Order Today');
    expect(slots.ctas.tertiary?.text).toBe('Join Now');

    const bullets = slots.body_sections.find((s) => s.kind === 'bullets');
    expect(bullets).toBeDefined();
    if (bullets?.kind === 'bullets') {
      expect(bullets.items.length).toBe(5);
      expect(bullets.items[0]?.icon_url).toBe('https://cdn.example.com/i1.png');
    }

    const faq = slots.body_sections.find((s) => s.kind === 'faq');
    expect(faq).toBeDefined();
    if (faq?.kind === 'faq') {
      expect(faq.items.length).toBe(5);
    }

    expect(slots.offer_stack.core).toBe('HydroGlow Bottle');
    expect(slots.offer_stack.bonuses.length).toBe(1);
    expect(slots.trust_badges.length).toBe(2);
    expect(slots.social_proof.badges_urls.length).toBe(2);
  });
});

describe('composeSlots — robustness', () => {
  it('missing FAQ items → no faq body_section', () => {
    const cd = makeCopyDeck({ faq: [] });
    const slots = composeSlots({
      copyDeck: cd,
      visualAssets: makeVisualAssets(),
      templateName: 'long-form-advertorial',
    });
    const faq = slots.body_sections.find((s) => s.kind === 'faq');
    expect(faq).toBeUndefined();
  });

  it('missing icons → bullets have no icon_url', () => {
    const va = makeVisualAssets();
    va.assets.icons = [];
    const slots = composeSlots({
      copyDeck: makeCopyDeck(),
      visualAssets: va,
      templateName: 'long-form-advertorial',
    });
    const bullets = slots.body_sections.find((s) => s.kind === 'bullets');
    if (bullets?.kind === 'bullets') {
      expect(bullets.items.every((b) => b.icon_url === undefined)).toBe(true);
    }
  });

  it('missing hero.desktop → falls back to og then mobile', () => {
    const va = makeVisualAssets();
    // simulate desktop missing (empty string) — schema requires .url() so use placeholder.
    va.assets.hero.urls_by_size = {
      desktop: '',
      og: 'https://cdn.example.com/hero-og.png',
      mobile: 'https://cdn.example.com/hero-mobile.png',
    };
    const slots = composeSlots({
      copyDeck: makeCopyDeck(),
      visualAssets: va,
      templateName: 'short-form-direct',
    });
    expect(slots.hero.image_url).toBe('https://cdn.example.com/hero-og.png');
  });

  it('missing all hero sizes → image_url is empty string (never throws)', () => {
    const va = makeVisualAssets();
    va.assets.hero.urls_by_size = { desktop: '', og: '', mobile: '' };
    const slots = composeSlots({
      copyDeck: makeCopyDeck(),
      visualAssets: va,
      templateName: 'short-form-direct',
    });
    expect(slots.hero.image_url).toBe('');
  });

  it('logo falls back through full → mark → wordmark', () => {
    const va = makeVisualAssets();
    va.brand.logo_urls = {
      full: '',
      mark: 'https://cdn.example.com/mark.png',
      wordmark: 'https://cdn.example.com/word.png',
    };
    const slots = composeSlots({
      copyDeck: makeCopyDeck(),
      visualAssets: va,
      templateName: 'story-driven',
    });
    expect(slots.brand.logo_url).toBe('https://cdn.example.com/mark.png');
  });

  it('short-form-direct template skips story section synthesis', () => {
    const slots = composeSlots({
      copyDeck: makeCopyDeck(),
      visualAssets: makeVisualAssets(),
      templateName: 'short-form-direct',
    });
    const story = slots.body_sections.find((s) => s.kind === 'story');
    expect(story).toBeUndefined();
  });
});

// ─── SM-5.5 — composeBepurexSlots tests ────────────────────────────────────

function makeExtractedSource(
  overrides: Partial<ExtractedSourceLike> = {},
): ExtractedSourceLike {
  return {
    copy: {
      hero_headline: 'The pharmacist-formulated wellness stack',
      hero_subhead: 'Clinical-grade dosing, delivered fresh.',
      benefit_bullets: [
        'Third-party lab verified potency',
        'Vegan, GMO-free, no fillers',
        'Ships in 48h across Europe',
      ],
      faq: [
        { q: 'When will I feel the effects?', a: 'Most customers report a boost within 14 days.' },
        { q: 'Safe with medications?', a: 'Consult your GP if you take blood thinners.' },
      ],
      testimonials: [
        { author: 'Sofia R.', content: 'I got my energy back within two weeks.' },
        { author: 'Marco B.', content: 'Finally a supplement that respects my digestion.' },
      ],
      guarantee: '60-day money-back guarantee — no questions asked.',
    },
    imagery: {
      hero_url: 'https://cdn.example.com/hero.jpg',
      gallery_urls: [
        'https://cdn.example.com/g1.jpg',
        'https://cdn.example.com/g2.jpg',
      ],
      lifestyle_urls: ['https://cdn.example.com/l1.jpg'],
      logo_url: 'https://cdn.example.com/logo.png',
    },
    commerce: {
      reviews: [
        { author: 'Anna F.', content: 'Excellent formula.', rating: 5 },
      ],
      bundles: [
        { name: '1 bottle', price_cents: 3495, compare_at_cents: 4495, qty: 60 },
        { name: '2 bottles', price_cents: 6295, compare_at_cents: 8990, qty: 120 },
        { name: '3 bottles', price_cents: 8495, compare_at_cents: 13485, qty: 180 },
      ],
      currency: 'EUR',
      badges: [
        'https://cdn.example.com/badges/gmp.png',
        'https://cdn.example.com/badges/vegan.png',
      ],
    },
    dynamic_extras: [
      {
        kind: 'problem_agitation',
        heading: 'The problem with generic supplements',
        payload: {
          paragraphs: [
            'You have tried every "miracle" pill and still feel tired.',
            'Mass-produced formulas skip the doses that actually matter.',
          ],
        },
        llm_verdict: 'recommended',
        llm_reason: 'Strong emotional hook',
      },
      {
        kind: 'stats',
        heading: 'By the numbers',
        payload: {
          items: [
            { label: 'Customers', value: '12k+' },
            { label: 'Trustpilot', value: '4.8/5' },
          ],
        },
        llm_verdict: 'optional',
        llm_reason: 'Nice-to-have social proof',
      },
    ],
    meta: {
      detected_language: 'en',
    },
    ...overrides,
  };
}

function makeBrandExtract(overrides: Partial<BrandExtractLike> = {}): BrandExtractLike {
  return {
    primary: '#0a5f3a',
    secondary: '#f4a300',
    accent: '#c8322f',
    bg: '#fdfaf3',
    text: '#111111',
    headline_font: 'Playfair Display',
    body_font: 'Inter',
    logo_url: 'https://cdn.example.com/brand-logo.png',
    ...overrides,
  };
}

describe('composeBepurexSlots — happy path', () => {
  it('maps all 12 fixed slots from deterministic extracted + brand input', () => {
    const slots = composeBepurexSlots({
      extracted: makeExtractedSource(),
      brand: makeBrandExtract(),
    });

    // Slot 1: logo (brand.logo_url takes priority over extracted)
    expect(slots.brand.logo_url).toBe('https://cdn.example.com/brand-logo.png');
    // Slot 2: palette (1:1 mapping from brand-extractor)
    expect(slots.brand.palette).toEqual({
      primary: '#0a5f3a',
      secondary: '#f4a300',
      accent: '#c8322f',
      bg: '#fdfaf3',
      text: '#111111',
    });
    // Slot 3: typography
    expect(slots.brand.typography.headline_font).toBe('Playfair Display');
    expect(slots.brand.typography.body_font).toBe('Inter');
    // Slot 4/5: hero headline + subhead from extracted (no copyDeck override)
    expect(slots.hero.headline).toBe('The pharmacist-formulated wellness stack');
    expect(slots.hero.subhead).toBe('Clinical-grade dosing, delivered fresh.');
    // Slot 6: hero image
    expect(slots.hero.image_url).toBe('https://cdn.example.com/hero.jpg');
    // Slot 7: benefit_bullets rendered as body_section
    const bullets = slots.body_sections.find((s) => s.kind === 'bullets');
    expect(bullets).toBeDefined();
    if (bullets?.kind === 'bullets') {
      expect(bullets.items).toHaveLength(3);
      expect(bullets.items[0]?.text).toBe('Third-party lab verified potency');
    }
    // Slot 8: bundle_slots mapped from commerce.bundles
    expect(slots.bundle_slots).toHaveLength(3);
    expect(slots.bundle_slots?.[0]?.priceCents).toBe(3495);
    expect(slots.bundle_slots?.[1]?.compareAtPriceCents).toBe(8990);
    // Slot 9: testimonials as body_section
    const testimonials = slots.body_sections.find((s) => s.kind === 'testimonials');
    expect(testimonials).toBeDefined();
    if (testimonials?.kind === 'testimonials') {
      expect(testimonials.items).toHaveLength(2);
      expect(testimonials.items[0]?.source).toBe('Sofia R.');
    }
    // Slot 10: faq
    const faq = slots.body_sections.find((s) => s.kind === 'faq');
    expect(faq).toBeDefined();
    if (faq?.kind === 'faq') {
      expect(faq.items).toHaveLength(2);
      expect(faq.items[0]?.question).toBe('When will I feel the effects?');
    }
    // Slot 11: guarantee
    const guarantee = slots.body_sections.find((s) => s.kind === 'guarantee');
    expect(guarantee).toBeDefined();
    if (guarantee?.kind === 'guarantee') {
      expect(guarantee.body).toBe('60-day money-back guarantee — no questions asked.');
    }
    // Slot 12: sticky_cta with price_hint from smallest bundle
    expect(slots.sticky_cta?.text).toBe('Compre agora'); // fallback since no copyDeck
    expect(slots.sticky_cta?.price_hint).toBe('EUR 34.95');
    // Language default from meta
    expect(slots.language).toBe('en');
  });

  it('populates dynamic_extras respecting llm_verdict priority (recommended before optional, cap 3)', () => {
    const slots = composeBepurexSlots({
      extracted: makeExtractedSource(),
      brand: makeBrandExtract(),
    });
    expect(slots.dynamic_extras).toHaveLength(2);
    // Recommended first
    expect(slots.dynamic_extras[0]?.kind).toBe('problem_agitation');
    expect(slots.dynamic_extras[1]?.kind).toBe('stats');
  });

  it('caps dynamic_extras at 3 even when more are provided', () => {
    const extracted = makeExtractedSource({
      dynamic_extras: [
        { kind: 'bullets', heading: 'A', payload: { items: [] }, llm_verdict: 'recommended' },
        { kind: 'stats', heading: 'B', payload: { items: [] }, llm_verdict: 'recommended' },
        { kind: 'gallery', heading: 'C', payload: { image_urls: [] }, llm_verdict: 'recommended' },
        { kind: 'story', heading: 'D', payload: { paragraphs: [] }, llm_verdict: 'recommended' },
        { kind: 'comparison', heading: 'E', payload: { rows: [] }, llm_verdict: 'optional' },
      ],
    });
    const slots = composeBepurexSlots({ extracted, brand: makeBrandExtract() });
    expect(slots.dynamic_extras).toHaveLength(3);
    expect(slots.dynamic_extras.map((e) => e.heading)).toEqual(['A', 'B', 'C']);
  });

  it('filters out extras with verdict=skip', () => {
    const extracted = makeExtractedSource({
      dynamic_extras: [
        { kind: 'bullets', heading: 'Skip me', payload: { items: [] }, llm_verdict: 'skip' },
        { kind: 'stats', heading: 'Keep me', payload: { items: [] }, llm_verdict: 'recommended' },
      ],
    });
    const slots = composeBepurexSlots({ extracted, brand: makeBrandExtract() });
    expect(slots.dynamic_extras).toHaveLength(1);
    expect(slots.dynamic_extras[0]?.heading).toBe('Keep me');
  });
});

describe('composeBepurexSlots — fallbacks (§7)', () => {
  it('falls back to placeholder image when hero_url is null and no gallery', () => {
    const extracted = makeExtractedSource({
      imagery: {
        hero_url: null,
        gallery_urls: [],
        lifestyle_urls: [],
        logo_url: null,
      },
    });
    const slots = composeBepurexSlots({ extracted, brand: makeBrandExtract({ logo_url: null }) });
    expect(slots.hero.image_url).toContain('placehold.co');
    expect(slots.brand.logo_url).toBe('');
  });

  it('falls back to gallery[0] when hero_url is null but gallery exists', () => {
    const extracted = makeExtractedSource({
      imagery: {
        hero_url: null,
        gallery_urls: ['https://cdn.example.com/gallery-first.jpg'],
        lifestyle_urls: [],
        logo_url: null,
      },
    });
    const slots = composeBepurexSlots({ extracted, brand: makeBrandExtract() });
    expect(slots.hero.image_url).toBe('https://cdn.example.com/gallery-first.jpg');
  });

  it('emits fallback bundle when commerce.bundles is empty', () => {
    const extracted = makeExtractedSource({
      commerce: {
        reviews: [],
        bundles: [],
        currency: 'EUR',
        badges: [],
      },
    });
    const slots = composeBepurexSlots({ extracted, brand: makeBrandExtract() });
    expect(slots.bundle_slots).toHaveLength(1);
    expect(slots.bundle_slots?.[0]?.name).toBe('1 unit');
    expect(slots.bundle_slots?.[0]?.priceCents).toBe(0);
    // sticky_cta has no price_hint when no priced bundle
    expect(slots.sticky_cta?.price_hint).toBeUndefined();
  });

  it('emits i18n guarantee fallback per language when extracted.copy.guarantee is missing', () => {
    const extracted = makeExtractedSource({
      copy: {
        hero_headline: 'x',
        // guarantee omitted
      },
      meta: { detected_language: 'pt-BR' },
    });
    const slots = composeBepurexSlots({ extracted, brand: makeBrandExtract() });
    const g = slots.body_sections.find((s) => s.kind === 'guarantee');
    expect(g).toBeDefined();
    if (g?.kind === 'guarantee') {
      expect(g.body).toContain('Garantia de 30 dias');
    }
  });

  it('falls back to English guarantee for unknown language', () => {
    const extracted = makeExtractedSource({
      copy: { hero_headline: 'x' },
      meta: { detected_language: 'zh-CN' },
    });
    const slots = composeBepurexSlots({ extracted, brand: makeBrandExtract() });
    const g = slots.body_sections.find((s) => s.kind === 'guarantee');
    if (g?.kind === 'guarantee') {
      expect(g.body).toBe('30-day money-back guarantee');
    }
  });

  it('omits testimonials/faq body_sections when arrays are empty', () => {
    const extracted = makeExtractedSource({
      copy: {
        hero_headline: 'x',
        benefit_bullets: [],
        faq: [],
        testimonials: [],
      },
    });
    const slots = composeBepurexSlots({ extracted, brand: makeBrandExtract() });
    expect(slots.body_sections.find((s) => s.kind === 'bullets')).toBeUndefined();
    expect(slots.body_sections.find((s) => s.kind === 'faq')).toBeUndefined();
    expect(slots.body_sections.find((s) => s.kind === 'testimonials')).toBeUndefined();
    // Guarantee still present (always emitted with fallback)
    expect(slots.body_sections.find((s) => s.kind === 'guarantee')).toBeDefined();
  });
});

describe('composeBepurexSlots — optional copyDeck/visualAssets augmentation', () => {
  it('copyDeck.hooks[0] overrides extracted hero headline when provided', () => {
    const copyDeck = {
      schema_version: '1.0.0',
      language: 'en',
      hooks: [
        { text: 'AI-curated headline wins', awareness_stage: 'unaware' as const, framework_source: 'schwartz' as const },
      ],
      subheadlines: ['AI subhead'],
      benefit_bullets: [],
      ctas: [{ text: 'Buy now', variant: 'a' as const, urgency_type: 'scarcity' as const }],
      faq: [],
      offer_stack: {
        main_offer: 'Wellness stack',
        bonuses: [],
        guarantee: '90-day',
        price_anchor: 'Was 99',
        real_value_stack: '200',
      },
      guarantee: '90-day guarantee',
      urgency_copy: 'Only 47 left',
      social_proof_blocks: [],
      voc_verbatim_used: [],
      contributing_agents: [],
    } as unknown as CopyDeck;
    const slots = composeBepurexSlots({
      extracted: makeExtractedSource(),
      brand: makeBrandExtract(),
      copyDeck,
    });
    expect(slots.hero.headline).toBe('AI-curated headline wins');
    expect(slots.hero.subhead).toBe('AI subhead');
    expect(slots.ctas.primary.text).toBe('Buy now');
    expect(slots.offer_stack.core).toBe('Wellness stack');
    expect(slots.sticky_cta?.text).toBe('Buy now');
  });

  it('visualAssets.assets.trust_badges override extracted commerce.badges', () => {
    const visualAssets = {
      schema_version: '1.0.0',
      brand: {
        name: 'Bepurex',
        tagline: 'Wellness',
        logo_urls: {
          full: 'https://cdn.example.com/va-logo.png',
          mark: '',
          wordmark: '',
        },
        palette: {
          primary: '#000',
          secondary: '#111',
          accent: '#222',
          bg: '#fff',
          text: '#000',
        },
        typography: { headline_font: 'Inter', body_font: 'Inter' },
      },
      assets: {
        hero: {
          urls_by_size: {
            desktop: 'https://cdn.example.com/va-hero.jpg',
            og: '',
            mobile: '',
          },
        },
        lifestyle: [],
        icons: [],
        trust_badges: [
          'https://cdn.example.com/va-badge-1.png',
          'https://cdn.example.com/va-badge-2.png',
        ],
        before_after: ['https://cdn.example.com/before-after.png'],
      },
      contributing_agents: [],
      director_notes: 'test',
    } as unknown as VisualAssets;

    const slots = composeBepurexSlots({
      extracted: makeExtractedSource(),
      brand: makeBrandExtract(),
      visualAssets,
    });
    expect(slots.trust_badges).toHaveLength(2);
    expect(slots.trust_badges[0]?.url).toBe('https://cdn.example.com/va-badge-1.png');
    expect(slots.social_proof.before_after_urls).toEqual(['https://cdn.example.com/before-after.png']);
  });
});

describe('composeBepurexSlots — no regression on composeSlots', () => {
  it('composeSlots (Autopilot legacy) still produces expected output', () => {
    // Sanity check that adding composeBepurexSlots did not break the pre-existing function.
    const cd: CopyDeck = {
      schema_version: '1.0.0',
      language: 'en',
      hooks: [{ text: 'H', awareness_stage: 'unaware', framework_source: 'schwartz' }],
      subheadlines: ['S'],
      benefit_bullets: [{ text: 'B', desire_addressed: 'refresh' }],
      ctas: [{ text: 'CTA', variant: 'a', urgency_type: 'time_limited' }],
      faq: [{ question: 'q', answer: 'a', objection_addressed: 'quality' }],
      offer_stack: {
        main_offer: 'M',
        bonuses: [],
        guarantee: 'G',
        price_anchor: 'P',
        real_value_stack: 'V',
      },
      guarantee: 'G',
      urgency_copy: 'U',
      social_proof_blocks: [],
      voc_verbatim_used: [],
      contributing_agents: [],
    };
    const va: VisualAssets = {
      schema_version: '1.0.0',
      brand: {
        name: 'X',
        tagline: 'Y',
        logo_urls: { full: 'https://cdn/x.png', mark: '', wordmark: '' },
        palette: { primary: '#000', secondary: '#111', accent: '#222', bg: '#fff', text: '#000' },
        typography: { headline_font: 'I', body_font: 'I' },
      },
      assets: {
        hero: { urls_by_size: { desktop: 'https://cdn/h.png', og: '', mobile: '' } },
        lifestyle: [],
        icons: [],
        trust_badges: [],
      },
      contributing_agents: [],
      director_notes: 'x',
    };
    const s = composeSlots({ copyDeck: cd, visualAssets: va, templateName: 'short-form-direct' });
    expect(s.hero.headline).toBe('H');
    expect(s.ctas.primary.text).toBe('CTA');
  });
});

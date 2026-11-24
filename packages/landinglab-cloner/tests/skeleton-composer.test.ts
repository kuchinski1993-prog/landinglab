// skeleton-composer tests — SM-2.4
//
// Cobre:
//   AC1/AC2/AC3: assinatura + shape do retorno
//   AC4:  12 slots fixos com input determinístico
//   AC5:  3 slots dinâmicos com filtro recommended > optional > cap 3
//   AC6:  reviews IA quando fonte tem zero (mock Gemini)
//   AC7:  threshold lifestyle < 3 (composer expõe LIFESTYLE_MIN_THRESHOLD)
//   AC8:  logoDecision: extracted_from_fonte OR none
//   AC9:  input determinístico → assert slots exatos
//   AC10: mock Gemini path → aiGeneratedReviewsCount === 5
//   AC11: reviews não-vazias → aiGeneratedReviewsCount === 0 e ZERO chamadas Gemini
//
// Absorção SM-5.5: teste extra valida `copyDeck?` e `visualAssets?` params.

import { describe, expect, it, vi } from 'vitest';

import type { GeminiTextOpts, GeminiTextResult } from '../src/providers/gemini-text.js';
import {
  AI_REVIEWS_COUNT,
  DEFAULT_PALETTE,
  DEFAULT_TYPOGRAPHY,
  HERO_PLACEHOLDER_URL,
  LIFESTYLE_MIN_THRESHOLD,
  MAX_DYNAMIC_EXTRAS,
  composeBepurexSlots,
} from '../src/agents/skeleton-composer.js';
import type {
  BrandLike,
  ComposeInput,
  CopyDeckOverride,
  ExtractedSourceJson,
  VisualAssetsOverride,
} from '../src/agents/skeleton-composer.types.js';

// ─── Fixtures determinísticas ───────────────────────────────────────────────

function makeExtracted(overrides: Partial<ExtractedSourceJson> = {}): ExtractedSourceJson {
  const base: ExtractedSourceJson = {
    copy: {
      hero_headline: 'The supplement stack pharmacists take themselves',
      hero_subhead: 'A clinical-grade formula, no fillers.',
      benefit_bullets: ['Clinical dosing', 'No fillers', 'Fresh from lab'],
      faq: [
        { q: 'When will I feel results?', a: '10-14 days for most people.' },
        { q: 'Safe with meds?', a: 'Consult your GP if on blood thinners.' },
      ],
      testimonials: [
        { author: 'Sofia R.', content: 'Got my energy back in two weeks.' },
      ],
    },
    imagery: {
      hero_url: 'https://cdn.example.com/bepurex/hero.jpg',
      gallery_urls: [
        'https://cdn.example.com/bepurex/g1.jpg',
        'https://cdn.example.com/bepurex/g2.jpg',
      ],
      lifestyle_urls: ['https://cdn.example.com/bepurex/l1.jpg'],
      logo_url: 'https://cdn.example.com/bepurex/logo.png',
    },
    brand: {
      colors_hex_candidates: ['#0a5f3a', '#f4a300'],
      fonts_used: ['Playfair Display', 'Inter'],
    },
    commerce: {
      reviews: [
        { author: 'Marco B.', content: 'Finally a supplement that respects my digestion.' },
      ],
      bundles: [
        { name: '1 bottle', price_cents: 3495, compare_at_cents: 4495, qty: 60 },
        { name: '2 bottles', price_cents: 6295, compare_at_cents: 8990, qty: 120 },
        { name: '3 bottles', price_cents: 8495, compare_at_cents: 13485, qty: 180 },
      ],
      currency: 'EUR',
      badges: ['Order the launch batch', 'Free EU shipping'],
    },
    dynamic_extras: [],
    meta: {
      partial: false,
      unresolved_fields: [],
      detected_language: 'en',
    },
  };
  return { ...base, ...overrides };
}

const brandFixture: BrandLike = {
  primary: '#0a5f3a',
  secondary: '#f4a300',
  accent: '#c8322f',
  bg: '#fdfaf3',
  text: '#111111',
  headline_font: 'Playfair Display',
  body_font: 'Inter',
  logo_url: 'https://cdn.example.com/bepurex/logo.png',
  logo_source: 'extracted_from_fonte',
};

function makeInput(overrides: Partial<ComposeInput> = {}): ComposeInput {
  return {
    extracted: makeExtracted(),
    brand: brandFixture,
    targetSkeleton: 'bepurex-advertorial-v1',
    language: 'en',
    ...overrides,
  };
}

// Mock Gemini: retorna 5 reviews estáveis.
function makeGeminiMock(count = AI_REVIEWS_COUNT): (opts: GeminiTextOpts) => Promise<GeminiTextResult> {
  const reviews = Array.from({ length: count }, (_, i) => ({
    content: `Review ${i + 1}: Really pleased after two weeks of daily use — energy is more stable and I do not need my afternoon coffee. Zero digestive issues.`,
    source: `Author ${i + 1}.`,
  }));
  return async (opts: GeminiTextOpts) => ({
    content: JSON.stringify({ reviews }),
    tokens_in: 150,
    tokens_out: 400,
    cost_usd: 0.0001,
    latency_ms: 200,
    model: opts.model ?? 'gemini-3.6-flash',
  });
}

// ─── AC1/AC2/AC3: shape ─────────────────────────────────────────────────────

describe('composeBepurexSlots — shape', () => {
  it('AC1/AC3: retorna { slots, dynamicExtrasStatus, aiGeneratedReviewsCount, logoDecision }', async () => {
    const result = await composeBepurexSlots(makeInput());
    expect(result).toHaveProperty('slots');
    expect(result).toHaveProperty('dynamicExtrasStatus');
    expect(result).toHaveProperty('aiGeneratedReviewsCount');
    expect(result).toHaveProperty('logoDecision');
  });

  it('AC2: aceita targetSkeleton advertorial + landing', async () => {
    const adv = await composeBepurexSlots(makeInput({ targetSkeleton: 'bepurex-advertorial-v1' }));
    const land = await composeBepurexSlots(makeInput({ targetSkeleton: 'bepurex-landing-v1' }));
    expect(adv.slots.language).toBe('en');
    expect(land.slots.language).toBe('en');
  });
});

// ─── AC4: 12 slots fixos ────────────────────────────────────────────────────

describe('composeBepurexSlots — 12 slots fixos (§7)', () => {
  it('slot 1 (logo) + slot 2 (palette) + slot 3 (typography) do brand', async () => {
    const { slots } = await composeBepurexSlots(makeInput());
    expect(slots.brand.logo_url).toBe('https://cdn.example.com/bepurex/logo.png');
    expect(slots.brand.palette.primary).toBe('#0a5f3a');
    expect(slots.brand.palette.bg).toBe('#fdfaf3');
    expect(slots.brand.typography.headline_font).toBe('Playfair Display');
    expect(slots.brand.typography.body_font).toBe('Inter');
  });

  it('slot 2: fallback palette Bepurex quando brand vem com hex vazio', async () => {
    const emptyBrand: BrandLike = {
      ...brandFixture,
      primary: '',
      secondary: '',
      accent: '',
      bg: '',
      text: '',
    };
    const { slots } = await composeBepurexSlots(makeInput({ brand: emptyBrand }));
    expect(slots.brand.palette.primary).toBe(DEFAULT_PALETTE.primary);
    expect(slots.brand.palette.bg).toBe(DEFAULT_PALETTE.bg);
  });

  it('slot 3: fallback typography Playfair+Inter quando brand vem sem fontes', async () => {
    const noFontsBrand: BrandLike = { ...brandFixture, headline_font: '', body_font: '' };
    const { slots } = await composeBepurexSlots(makeInput({ brand: noFontsBrand }));
    expect(slots.brand.typography.headline_font).toBe(DEFAULT_TYPOGRAPHY.headline_font);
    expect(slots.brand.typography.body_font).toBe(DEFAULT_TYPOGRAPHY.body_font);
  });

  it('slot 4 (hero.headline) + slot 5 (hero.subhead) do extracted.copy', async () => {
    const { slots } = await composeBepurexSlots(makeInput());
    expect(slots.hero.headline).toBe('The supplement stack pharmacists take themselves');
    expect(slots.hero.subhead).toBe('A clinical-grade formula, no fillers.');
  });

  it('slot 4: fallback i18n quando headline vazia', async () => {
    const noHeadline = makeExtracted({
      copy: {
        ...makeExtracted().copy,
        hero_headline: '',
      },
    });
    const { slots } = await composeBepurexSlots(makeInput({ extracted: noHeadline, language: 'it' }));
    expect(slots.hero.headline).toBe('Configura il titolo principale');
  });

  it('slot 6 (hero.image_url) do extracted.imagery.hero_url', async () => {
    const { slots } = await composeBepurexSlots(makeInput());
    expect(slots.hero.image_url).toBe('https://cdn.example.com/bepurex/hero.jpg');
  });

  it('slot 6: fallback pra primeira gallery quando hero_url ausente', async () => {
    const noHeroImg = makeExtracted({
      imagery: {
        ...makeExtracted().imagery,
        hero_url: null,
      },
    });
    const { slots } = await composeBepurexSlots(makeInput({ extracted: noHeroImg }));
    expect(slots.hero.image_url).toBe('https://cdn.example.com/bepurex/g1.jpg');
  });

  it('slot 6: fallback placeholder cinza quando nem gallery existe', async () => {
    const noImagesInput = makeExtracted({
      imagery: {
        hero_url: null,
        gallery_urls: [],
        lifestyle_urls: [],
        logo_url: null,
      },
    });
    const { slots } = await composeBepurexSlots(makeInput({ extracted: noImagesInput }));
    expect(slots.hero.image_url).toBe(HERO_PLACEHOLDER_URL);
  });

  it('slot 7 (benefit_bullets) vira BodySection bullets', async () => {
    const { slots } = await composeBepurexSlots(makeInput());
    const bullets = slots.body_sections.find((s) => s.kind === 'bullets');
    expect(bullets).toBeDefined();
    if (bullets?.kind === 'bullets') {
      expect(bullets.items).toHaveLength(3);
      expect(bullets.items[0]?.text).toBe('Clinical dosing');
    }
  });

  it('slot 8 (bundle_slots): 3 bundles → middle=popular, maior desconto=best', async () => {
    const { slots } = await composeBepurexSlots(makeInput());
    expect(slots.bundle_slots).toHaveLength(3);
    // Ordenado por preço asc: 3495 → 6295 → 8495
    expect(slots.bundle_slots?.[0]?.priceCents).toBe(3495);
    expect(slots.bundle_slots?.[1]?.priceCents).toBe(6295);
    // middle (idx 1) = popular; mas 'best' (maior savings absoluto: 13485-8495=4990) sobrescreve
    expect(slots.bundle_slots?.[2]?.highlight).toBe('best');
  });

  it('slot 8: fallback single "1 unit" quando não há bundles', async () => {
    const noBundles = makeExtracted({
      commerce: {
        ...makeExtracted().commerce,
        bundles: [],
      },
    });
    const { slots } = await composeBepurexSlots(makeInput({ extracted: noBundles }));
    expect(slots.bundle_slots).toHaveLength(1);
    expect(slots.bundle_slots?.[0]?.name).toBe('1 unit');
    expect(slots.bundle_slots?.[0]?.priceCents).toBe(0);
  });

  it('slot 9 (testimonials): mescla commerce.reviews + copy.testimonials', async () => {
    const { slots } = await composeBepurexSlots(makeInput());
    const testis = slots.body_sections.find((s) => s.kind === 'testimonials');
    expect(testis).toBeDefined();
    if (testis?.kind === 'testimonials') {
      // 1 do commerce + 1 do copy = 2
      expect(testis.items).toHaveLength(2);
      expect(testis.items[0]?.source).toBe('Marco B.');
      expect(testis.items[1]?.source).toBe('Sofia R.');
    }
  });

  it('slot 10 (faq): populada de extracted.copy.faq', async () => {
    const { slots } = await composeBepurexSlots(makeInput());
    const faq = slots.body_sections.find((s) => s.kind === 'faq');
    expect(faq).toBeDefined();
    if (faq?.kind === 'faq') {
      expect(faq.items).toHaveLength(2);
      expect(faq.items[0]?.question).toBe('When will I feel results?');
    }
  });

  it('slot 11 (guarantee): sempre presente com i18n fallback', async () => {
    const { slots } = await composeBepurexSlots(makeInput({ language: 'de' }));
    const guar = slots.body_sections.find((s) => s.kind === 'guarantee');
    expect(guar).toBeDefined();
    if (guar?.kind === 'guarantee') {
      expect(guar.body).toBe('30 Tage Geld-zurück-Garantie');
    }
  });

  it('slot 12 (sticky_cta): texto CTA + price_hint = cheapest bundle', async () => {
    const { slots } = await composeBepurexSlots(makeInput());
    expect(slots.sticky_cta?.text).toBe('Order the launch batch');
    expect(slots.sticky_cta?.price_hint).toBe('EUR 34,95');
  });
});

// ─── AC5: 3 slots dinâmicos ─────────────────────────────────────────────────

describe('composeBepurexSlots — dynamic extras (Nível 2.5)', () => {
  it('filtra por verdict recommended primeiro, depois optional, cap 3', async () => {
    const withExtras = makeExtracted({
      dynamic_extras: [
        {
          kind: 'stats',
          heading: 'By the numbers',
          payload: { items: [{ label: 'Customers', value: '12k+' }] },
          llm_verdict: 'optional',
          llm_reason: 'ok mas não crítico',
        },
        {
          kind: 'problem_agitation',
          heading: 'The pain',
          payload: { paragraphs: ['You are tired.', 'You have tried everything.'] },
          llm_verdict: 'recommended',
          llm_reason: 'converte muito',
        },
        {
          kind: 'gallery',
          heading: 'Product shots',
          payload: { image_urls: ['https://cdn.example.com/x1.jpg', 'https://cdn.example.com/x2.jpg'] },
          llm_verdict: 'recommended',
          llm_reason: 'visual proof',
        },
        {
          kind: 'comparison',
          heading: 'vs. competitors',
          payload: {
            rows: [
              { feature: 'Dosing', ours: 'Clinical', theirs: 'Under-dosed' },
            ],
          },
          llm_verdict: 'skip',
          llm_reason: 'genérico',
        },
      ],
    });
    const result = await composeBepurexSlots(makeInput({ extracted: withExtras }));
    // 2 recommended + 1 optional = 3 total (skip filtrado)
    expect(result.slots.dynamic_extras).toHaveLength(3);
    expect(result.slots.dynamic_extras[0]?.kind).toBe('problem_agitation'); // recommended primeiro
    expect(result.slots.dynamic_extras[1]?.kind).toBe('gallery'); // recommended
    expect(result.slots.dynamic_extras[2]?.kind).toBe('stats'); // optional depois

    // Status: approved apenas nos recommended
    expect(result.dynamicExtrasStatus[0]?.approved).toBe(true);
    expect(result.dynamicExtrasStatus[1]?.approved).toBe(true);
    expect(result.dynamicExtrasStatus[2]?.approved).toBe(false);
    expect(result.dynamicExtrasStatus[0]?.slot_index).toBe(0);
    expect(result.dynamicExtrasStatus[2]?.slot_index).toBe(2);
  });

  it('cap em MAX_DYNAMIC_EXTRAS mesmo se todos são recommended', async () => {
    const extras: ExtractedSourceJson['dynamic_extras'] = Array.from({ length: 5 }, (_, i) => ({
      kind: 'bullets' as const,
      heading: `Section ${i}`,
      payload: { items: [`item ${i}`] },
      llm_verdict: 'recommended' as const,
      llm_reason: 'ok',
    }));
    const result = await composeBepurexSlots(
      makeInput({ extracted: makeExtracted({ dynamic_extras: extras }) }),
    );
    expect(result.slots.dynamic_extras).toHaveLength(MAX_DYNAMIC_EXTRAS);
  });

  it('ignora payload malformado silenciosamente', async () => {
    const bad = makeExtracted({
      dynamic_extras: [
        {
          kind: 'stats',
          heading: 'Broken',
          payload: null, // Malformado — deveria ser { items: [...] }
          llm_verdict: 'recommended',
          llm_reason: 'ok',
        },
      ],
    });
    const result = await composeBepurexSlots(makeInput({ extracted: bad }));
    expect(result.slots.dynamic_extras).toHaveLength(0);
  });
});

// ─── AC6/AC10: FR-10 reviews IA ─────────────────────────────────────────────

describe('composeBepurexSlots — FR-10 reviews IA (Gemini)', () => {
  it('AC10: reviews vazias → dispara Gemini → aiGeneratedReviewsCount === 5', async () => {
    const noReviews = makeExtracted({
      copy: { ...makeExtracted().copy, testimonials: [] },
      commerce: { ...makeExtracted().commerce, reviews: [] },
    });
    const mock = vi.fn(makeGeminiMock(AI_REVIEWS_COUNT));
    const result = await composeBepurexSlots(
      makeInput({ extracted: noReviews, productName: 'Bepurex Wellness' }),
      { callGeminiFn: mock },
    );
    expect(result.aiGeneratedReviewsCount).toBe(AI_REVIEWS_COUNT);
    expect(mock).toHaveBeenCalledTimes(1);
    // Reviews viram BodySection testimonials
    const testis = result.slots.body_sections.find((s) => s.kind === 'testimonials');
    expect(testis?.kind).toBe('testimonials');
    if (testis?.kind === 'testimonials') {
      expect(testis.items).toHaveLength(AI_REVIEWS_COUNT);
      expect(testis.items[0]?.source).toBe('Author 1.');
    }
  });

  it('AC10: passa language pro prompt (Gemini system content contém idioma)', async () => {
    const noReviews = makeExtracted({
      copy: { ...makeExtracted().copy, testimonials: [] },
      commerce: { ...makeExtracted().commerce, reviews: [] },
    });
    const mock = vi.fn(makeGeminiMock());
    await composeBepurexSlots(
      makeInput({ extracted: noReviews, language: 'it' }),
      { callGeminiFn: mock },
    );
    const call = mock.mock.calls[0]?.[0];
    expect(call?.system).toContain('Italian');
    expect(call?.jsonMode).toBe(true);
  });

  it('AC11: reviews não-vazias → ZERO chamada Gemini + aiGeneratedReviewsCount === 0', async () => {
    const mock = vi.fn(makeGeminiMock());
    const result = await composeBepurexSlots(makeInput(), { callGeminiFn: mock });
    expect(result.aiGeneratedReviewsCount).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });

  it('falha silenciosa do Gemini → aiGeneratedReviewsCount === 0 (sem crash)', async () => {
    const noReviews = makeExtracted({
      copy: { ...makeExtracted().copy, testimonials: [] },
      commerce: { ...makeExtracted().commerce, reviews: [] },
    });
    const failingMock = vi.fn(async () => {
      throw new Error('Gemini HTTP 500');
    });
    const result = await composeBepurexSlots(
      makeInput({ extracted: noReviews }),
      { callGeminiFn: failingMock },
    );
    expect(result.aiGeneratedReviewsCount).toBe(0);
    expect(failingMock).toHaveBeenCalledTimes(1);
  });

  it('response Gemini com JSON inválido → aiGeneratedReviewsCount === 0', async () => {
    const noReviews = makeExtracted({
      copy: { ...makeExtracted().copy, testimonials: [] },
      commerce: { ...makeExtracted().commerce, reviews: [] },
    });
    const badMock = vi.fn(async (opts: GeminiTextOpts) => ({
      content: 'not-json-at-all',
      tokens_in: 10,
      tokens_out: 10,
      cost_usd: 0,
      latency_ms: 100,
      model: opts.model ?? 'gemini-3.6-flash',
    }));
    const result = await composeBepurexSlots(
      makeInput({ extracted: noReviews }),
      { callGeminiFn: badMock },
    );
    expect(result.aiGeneratedReviewsCount).toBe(0);
  });
});

// ─── AC7: threshold lifestyle ───────────────────────────────────────────────

describe('composeBepurexSlots — AC7 lifestyle threshold', () => {
  it('exporta LIFESTYLE_MIN_THRESHOLD = 3 (default G2)', () => {
    expect(LIFESTYLE_MIN_THRESHOLD).toBe(3);
  });
});

// ─── AC8: logoDecision ─────────────────────────────────────────────────────

describe('composeBepurexSlots — AC8 logoDecision', () => {
  it('brand.logo_url presente → source: extracted_from_fonte', async () => {
    const result = await composeBepurexSlots(makeInput());
    expect(result.logoDecision.source).toBe('extracted_from_fonte');
    expect(result.logoDecision.used_logo_url).toBe('https://cdn.example.com/bepurex/logo.png');
  });

  it('brand.logo_url null AND extracted.imagery.logo_url null → source: none', async () => {
    const noLogoBrand: BrandLike = { ...brandFixture, logo_url: null, logo_source: 'not_found' };
    const noLogoExtracted = makeExtracted({
      imagery: {
        ...makeExtracted().imagery,
        logo_url: null,
      },
    });
    const result = await composeBepurexSlots(
      makeInput({ brand: noLogoBrand, extracted: noLogoExtracted }),
    );
    expect(result.logoDecision.source).toBe('none');
    expect(result.logoDecision.used_logo_url).toBeNull();
  });

  it('brand.logo_url null MAS extracted.imagery.logo_url presente → source: extracted_from_fonte', async () => {
    const noLogoBrand: BrandLike = { ...brandFixture, logo_url: null, logo_source: 'not_found' };
    const result = await composeBepurexSlots(makeInput({ brand: noLogoBrand }));
    expect(result.logoDecision.source).toBe('extracted_from_fonte');
    expect(result.logoDecision.used_logo_url).toBe('https://cdn.example.com/bepurex/logo.png');
  });
});

// ─── SM-5.5 absorção: copyDeck? + visualAssets? ─────────────────────────────

describe('composeBepurexSlots — absorção SM-5.5 (copyDeck? + visualAssets?)', () => {
  it('copyDeck.hero_headline sobrescreve extracted.copy.hero_headline', async () => {
    const copyDeck: CopyDeckOverride = {
      hero_headline: 'REBRANDED via copy-chief re-audit',
    };
    const result = await composeBepurexSlots(makeInput({ copyDeck }));
    expect(result.slots.hero.headline).toBe('REBRANDED via copy-chief re-audit');
  });

  it('copyDeck.benefit_bullets sobrescreve extracted.copy.benefit_bullets', async () => {
    const copyDeck: CopyDeckOverride = {
      benefit_bullets: ['NEW A', 'NEW B'],
    };
    const result = await composeBepurexSlots(makeInput({ copyDeck }));
    const bullets = result.slots.body_sections.find((s) => s.kind === 'bullets');
    if (bullets?.kind === 'bullets') {
      expect(bullets.items).toHaveLength(2);
      expect(bullets.items[0]?.text).toBe('NEW A');
    }
  });

  it('visualAssets.hero_url sobrescreve extracted.imagery.hero_url', async () => {
    const visualAssets: VisualAssetsOverride = {
      hero_url: 'https://augmented.example.com/hero.jpg',
      hero_srcset: {
        desktop: 'https://augmented.example.com/hero-desktop.jpg',
        mobile: 'https://augmented.example.com/hero-mobile.jpg',
      },
    };
    const result = await composeBepurexSlots(makeInput({ visualAssets }));
    expect(result.slots.hero.image_url).toBe('https://augmented.example.com/hero.jpg');
    expect(result.slots.hero.image_srcset?.desktop).toBe('https://augmented.example.com/hero-desktop.jpg');
  });

  it('visualAssets.extra_gallery_urls agrega gallery BodySection quando extracted tem gallery', async () => {
    const visualAssets: VisualAssetsOverride = {
      extra_gallery_urls: ['https://augmented.example.com/g3.jpg', 'https://augmented.example.com/g4.jpg'],
    };
    const result = await composeBepurexSlots(makeInput({ visualAssets }));
    const gallery = result.slots.body_sections.find((s) => s.kind === 'gallery');
    expect(gallery?.kind).toBe('gallery');
    if (gallery?.kind === 'gallery') {
      // 2 do extracted + 2 do enrichment = 4
      expect(gallery.image_urls).toHaveLength(4);
      expect(gallery.image_urls).toContain('https://augmented.example.com/g3.jpg');
    }
  });

  it('visualAssets.trust_badge_urls popula trust_badges + social_proof.badges_urls', async () => {
    const visualAssets: VisualAssetsOverride = {
      trust_badge_urls: ['https://augmented.example.com/badge1.png'],
      before_after_urls: ['https://augmented.example.com/ba1.jpg'],
    };
    const result = await composeBepurexSlots(makeInput({ visualAssets }));
    expect(result.slots.trust_badges).toHaveLength(1);
    expect(result.slots.trust_badges[0]?.url).toBe('https://augmented.example.com/badge1.png');
    expect(result.slots.social_proof.badges_urls).toContain('https://augmented.example.com/badge1.png');
    expect(result.slots.social_proof.before_after_urls).toContain('https://augmented.example.com/ba1.jpg');
  });

  it('copyDeck.cta_primary_text sobrescreve default (badges[0])', async () => {
    const copyDeck: CopyDeckOverride = {
      cta_primary_text: 'Get the launch batch — 40% off',
    };
    const result = await composeBepurexSlots(makeInput({ copyDeck }));
    expect(result.slots.ctas.primary.text).toBe('Get the launch batch — 40% off');
    expect(result.slots.hero.cta_primary.text).toBe('Get the launch batch — 40% off');
    expect(result.slots.sticky_cta?.text).toBe('Get the launch batch — 40% off');
  });

  it('copyDeck.guarantee sobrescreve i18n default', async () => {
    const copyDeck: CopyDeckOverride = {
      guarantee: '90-day happiness guarantee',
    };
    const result = await composeBepurexSlots(makeInput({ copyDeck }));
    const guar = result.slots.body_sections.find((s) => s.kind === 'guarantee');
    if (guar?.kind === 'guarantee') {
      expect(guar.body).toBe('90-day happiness guarantee');
    }
    expect(result.slots.offer_stack.guarantee).toBe('90-day happiness guarantee');
  });
});

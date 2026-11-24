// Story 13.6 AC28 (Wave 2) — Build Squad orchestrator tests.
//
// Mocks DB with a chainable builder pattern (mirrors landinglab-visual tests).
// The point of these tests is DB flow (UPDATE base EN, UPSERT variant), retry,
// and cost aggregation — NOT the deterministic agents (which have own tests).

import { describe, expect, it } from 'vitest';
import type { Database } from '@blackshop/db';
import type { Pir } from '@blackshop/landinglab-research';
import type { VisualAssets } from '@blackshop/landinglab-visual';

import { runBuildSquad } from './orchestrator.js';
import type { ClaudeHaikuClient } from './providers/claude-haiku.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

function makePir(): Pir {
  return {
    schema_version: '1.0.0',
    identity: {
      name: 'HydroGlow',
      brand: null,
      category: 'wellness',
      model: null,
      price: 39.99,
      currency: 'USD',
      images: [],
      specs: {},
      variants: [],
    },
    market: { sophistication_level: 2, competitors: [], trends: [], gap_vs_competitors: null },
    avatar: {
      demographics: { age_range: '25-40', gender: 'mixed', income_bracket: null, geo: [] },
      psychographics: { identity: null, lifestyle: 'active', beliefs: [] },
      jobs_to_be_done: [],
    },
    voc: {
      language_bank: ['keeps me hydrated'],
      top_pains: [],
      top_desires: [{ desire: 'stay energized', frequency: 10, verbatim: [] }],
      top_objections: [],
      dream_outcomes: [],
    },
    desired_outcomes: { opportunities: [] },
    awareness_stages: [],
    value_equation: {
      dream_outcome: 'feel your best',
      perceived_likelihood: 0.7,
      time_delay: '1 week',
      effort_sacrifice: 'minimal',
    },
    evidence: { reviews_analyzed: 0, sources: [], confidence_score: 0.8, gaps: ['gap-1'] },
  };
}

function makeCopyDeckContent(language: 'en' | 'de' | 'it' = 'en') {
  return {
    schema_version: '1.0.0',
    language,
    hooks: [
      { text: 'The last bottle you will ever need in your life.', awareness_stage: 'unaware', framework_source: 'schwartz' },
      { text: 'Save 200 dollars per year on plastic water bottles.', awareness_stage: 'problem_aware', framework_source: 'hormozi' },
      { text: 'Join 12,000 wellness-focused people around the world.', awareness_stage: 'most_aware', framework_source: 'cialdini' },
    ],
    subheadlines: ['Made from 100% recycled materials worldwide.'],
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
      { question: 'How long shipping?', answer: 'Ships in 3-5 business days worldwide.', objection_addressed: 'time' },
      { question: 'Is there warranty?', answer: 'Yes lifetime warranty against defects.', objection_addressed: 'quality' },
      { question: 'Can I return?', answer: 'Yes 30-day money-back guarantee.', objection_addressed: 'risk' },
      { question: 'Is BPA-free?', answer: 'Yes all our bottles are BPA-free food-safe.', objection_addressed: 'safety' },
      { question: 'How to clean?', answer: 'Dishwasher-safe on the top rack always.', objection_addressed: 'convenience' },
    ],
    offer_stack: {
      main_offer: 'HydroGlow Water Bottle',
      bonuses: [],
      guarantee: '30-day money-back',
      price_anchor: 'Was $79',
      real_value_stack: '$200+ savings/year',
    },
    guarantee: 'Try HydroGlow for 30 days — if you do not love it, we refund every penny back to you.',
    urgency_copy: 'Only 47 left in stock today at this price point. Restock is 3 weeks away.',
    social_proof_blocks: [
      { type: 'stat', content: '12,000 five-star reviews' },
      { type: 'review', content: 'Best bottle ever', source: 'Amazon verified' },
    ],
    voc_verbatim_used: ['keeps me hydrated', 'love the sleek design', 'sturdy and light'],
    contributing_agents: [],
  };
}

function makeVisualAssetsRow(): {
  brand: VisualAssets['brand'];
  assets: VisualAssets['assets'];
  contributingAgents: unknown;
  directorNotes: string;
} {
  return {
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
    contributingAgents: [],
    directorNotes: 'test-only director notes for orchestrator input fixtures',
  };
}

function makeStubHaiku(): ClaudeHaikuClient {
  return {
    async generateMetaDescription() {
      return null; // force deterministic fallback → predictable output + zero cost
    },
  };
}

// ─── Mock DB ─────────────────────────────────────────────────────────────
//
// Chainable builder: intercepts .select/.update/.insert. The chain does NOT
// evaluate lazily — it resolves at the terminal await. We register expected
// table→row response mappings via `state.tableRows` keyed by a fingerprint
// derived from the first .from() call.

interface MockState {
  pir: Pir;
  visualAssetsRow: ReturnType<typeof makeVisualAssetsRow>;
  copyDecks: Array<{ id: string; language: string; content: unknown }>;
  baseLandingPage: { id: string; storeId: string; slug: string; contentLanguage: string | null };
  updates: unknown[];
  inserts: unknown[];
  upserts: unknown[];
  existingVariantSlugs: Set<string>; // for upsert-conflict simulation
}

function makeMockDb(state: MockState): Database {
  return {
    select(_shape?: unknown) {
      return {
        from(table: unknown) {
          // Distinguish tables by column presence in the shape. Since we don't
          // parse the shape, we peek at the last where() call to route.
          const t = table as { [k: string]: unknown };
          return {
            where(_pred: unknown) {
              return {
                limit: async (_n: number) => {
                  // Route by column presence.
                  if ('content' in t && 'evidenceGaps' in t) {
                    // landing_pir_documents
                    return [{ content: state.pir }];
                  }
                  if ('brand' in t && 'assets' in t) {
                    // landing_visual_assets .by id
                    return [state.visualAssetsRow];
                  }
                  if ('slug' in t && 'storeId' in t) {
                    // landing_pages
                    return [
                      {
                        id: state.baseLandingPage.id,
                        storeId: state.baseLandingPage.storeId,
                        slug: state.baseLandingPage.slug,
                        contentLanguage: state.baseLandingPage.contentLanguage,
                      },
                    ];
                  }
                  return [];
                },
                orderBy(_o: unknown) {
                  return {
                    limit: async (_n: number) => {
                      // fallback path for landing_visual_assets by landingPageId
                      if ('brand' in t && 'assets' in t) {
                        return [state.visualAssetsRow];
                      }
                      return [];
                    },
                  };
                },
                async then(resolve: (v: unknown) => void) {
                  // used for `.where(...)` awaited directly (loadCopyDecks path)
                  if ('language' in t && 'content' in t) {
                    resolve(state.copyDecks);
                  } else {
                    resolve([]);
                  }
                },
              };
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(row: unknown) {
          return {
            where(_pred: unknown) {
              return {
                returning: async (_shape: unknown) => {
                  state.updates.push(row);
                  return [{ id: state.baseLandingPage.id }];
                },
              };
            },
          };
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(row: unknown) {
          return {
            onConflictDoUpdate(cfg: unknown) {
              return {
                returning: async (_shape: unknown) => {
                  const r = row as { slug?: string };
                  if (r.slug && state.existingVariantSlugs.has(r.slug)) {
                    state.upserts.push({ row, cfg });
                    return [{ id: `variant-upsert-${r.slug}` }];
                  }
                  state.inserts.push(row);
                  state.existingVariantSlugs.add(r.slug ?? '');
                  return [{ id: `variant-${r.slug}` }];
                },
              };
            },
            returning: async (_shape: unknown) => {
              state.inserts.push(row);
              return [{ id: 'variant-generic' }];
            },
          };
        },
      };
    },
  } as unknown as Database;
}

function makeState(overrides: Partial<MockState> = {}): MockState {
  return {
    pir: makePir(),
    visualAssetsRow: makeVisualAssetsRow(),
    copyDecks: [
      { id: 'cd-en', language: 'en', content: makeCopyDeckContent('en') },
      { id: 'cd-de', language: 'de', content: makeCopyDeckContent('de') },
      { id: 'cd-it', language: 'it', content: makeCopyDeckContent('it') },
    ],
    baseLandingPage: {
      id: 'lp-1',
      storeId: 'l0i',
      slug: 'hydroglow',
      contentLanguage: null,
    },
    updates: [],
    inserts: [],
    upserts: [],
    existingVariantSlugs: new Set<string>(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('runBuildSquad — happy paths', () => {
  it('EN-only: updates the base landing_pages row (no INSERT)', async () => {
    const state = makeState();
    const db = makeMockDb(state);
    const result = await runBuildSquad(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        copyDeckIds: ['cd-en'],
        visualAssetsId: 'va-1',
        languages: ['en'],
      },
      { db, haiku: makeStubHaiku() },
    );
    expect(result.languagesGenerated).toEqual(['en']);
    expect(result.languageVariantIds).toEqual(['lp-1']);
    expect(state.updates.length).toBe(1);
    expect(state.inserts.length).toBe(0);
    expect(result.costUsd).toBe(0); // haiku fallback → zero cost
  });

  it('EN + DE + IT: 1 UPDATE + 2 INSERTs with distinct slugs', async () => {
    const state = makeState();
    const db = makeMockDb(state);
    const result = await runBuildSquad(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        copyDeckIds: ['cd-en', 'cd-de', 'cd-it'],
        visualAssetsId: 'va-1',
        languages: ['en', 'de', 'it'],
      },
      { db, haiku: makeStubHaiku() },
    );
    expect(result.languagesGenerated).toEqual(['en', 'de', 'it']);
    expect(state.updates.length).toBe(1);
    expect(state.inserts.length).toBe(2);
    const insertedSlugs = state.inserts.map((r) => (r as { slug: string }).slug);
    expect(insertedSlugs).toContain('hydroglow-de');
    expect(insertedSlugs).toContain('hydroglow-it');
  });

  it('base slug already ends in -de: variant uses baseSlug unchanged (no duplication)', async () => {
    const state = makeState({
      baseLandingPage: {
        id: 'lp-1',
        storeId: 'l0i',
        slug: 'hydroglow-de',
        contentLanguage: null,
      },
    });
    const db = makeMockDb(state);
    await runBuildSquad(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        copyDeckIds: ['cd-en', 'cd-de'],
        visualAssetsId: 'va-1',
        languages: ['en', 'de'],
      },
      { db, haiku: makeStubHaiku() },
    );
    const deInsert = state.inserts.find((r) => (r as { contentLanguage: string }).contentLanguage === 'de');
    expect((deInsert as { slug: string }).slug).toBe('hydroglow-de');
  });

  it('slug variant already exists → upsert path fires (no INSERT conflict)', async () => {
    const state = makeState({
      existingVariantSlugs: new Set(['hydroglow-de']),
    });
    const db = makeMockDb(state);
    const result = await runBuildSquad(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        copyDeckIds: ['cd-en', 'cd-de'],
        visualAssetsId: 'va-1',
        languages: ['en', 'de'],
      },
      { db, haiku: makeStubHaiku() },
    );
    expect(state.upserts.length).toBe(1);
    expect(state.inserts.length).toBe(0);
    expect(result.languageVariantIds).toContain('variant-upsert-hydroglow-de');
  });

  it('generation_notes populated for every variant (Article IV audit trail)', async () => {
    const state = makeState();
    const db = makeMockDb(state);
    await runBuildSquad(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        copyDeckIds: ['cd-en', 'cd-de'],
        visualAssetsId: 'va-1',
        languages: ['en', 'de'],
      },
      { db, haiku: makeStubHaiku() },
    );
    const allRows = [...state.updates, ...state.inserts];
    for (const row of allRows) {
      const md = (row as { buildMetadata: { generation_notes: string; template_used: string } })
        .buildMetadata;
      expect(md.generation_notes.length).toBeGreaterThanOrEqual(10);
      expect(md.template_used).toMatch(/long-form-advertorial|short-form-direct|story-driven/);
    }
  });

  it('cost aggregation across 3 languages (still zero with fallback Haiku)', async () => {
    const state = makeState();
    const db = makeMockDb(state);
    const result = await runBuildSquad(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        copyDeckIds: ['cd-en', 'cd-de', 'cd-it'],
        visualAssetsId: 'va-1',
        languages: ['en', 'de', 'it'],
      },
      { db, haiku: makeStubHaiku() },
    );
    expect(result.costUsd).toBe(0);
    // Trace has entries from each of the 5 agents × 3 languages = 15
    expect(result.agentTrace.length).toBe(15);
  });
});

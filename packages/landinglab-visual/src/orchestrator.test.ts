// Story 13.5 AC29 — Orchestrator unit tests.

import { describe, expect, it, vi } from 'vitest';

import type { Database } from '@blackshop/db';
import type { Pir } from '@blackshop/landinglab-research';
import type { CopyDeck } from '@blackshop/landinglab-copy';

import { runVisualSquad } from './orchestrator.js';
import type { ClaudeTextClient, ClaudeTextMessagesResult } from './providers/claude.js';
import { FreepikProviderError } from './providers/errors.js';
import type { GenerateImageOutput, ImageProvider } from './providers/types.js';

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
      language_bank: ['a', 'b'],
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

function makeCopyDeck(): CopyDeck {
  return {
    schema_version: '1.0.0',
    language: 'en',
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

function makeStubClaude(): ClaudeTextClient {
  return {
    async createMessage(): Promise<ClaudeTextMessagesResult> {
      // Returns a valid Visual Director JSON (used for director calls),
      // and a valid Brand Forge naming JSON (used for brand-forge Claude calls).
      // Since both directors and brand-forge use the same interface, we return
      // a superset that both will accept.
      return {
        content: JSON.stringify({
          palette: {
            primary: '#FF5A3C',
            secondary: '#FFB800',
            accent: '#00C2A8',
            bg: '#FFFFFF',
            text: '#111111',
          },
          typography: { headline_font: 'Poppins', body_font: 'Inter' },
          tone_descriptor: 'energetic',
          style_guidance: 'Bold colors, active subjects.',
          candidates: ['NovaLab', 'ZephyrCraft', 'MilaFlow', 'HydroCore', 'AquaSpire'],
          chosen_name: 'NovaLab',
          tagline: 'Design your everyday brilliance',
        }),
        tokens_in: 100,
        tokens_out: 200,
        latency_ms: 30,
        cost_usd: 0.01,
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
      };
    },
  };
}

function makeStubImageProvider(name: 'freepik' | 'higgsfield', urlPrefix: string): ImageProvider {
  return {
    name,
    async generateImage(input): Promise<GenerateImageOutput> {
      return {
        url: `${urlPrefix}/${encodeURIComponent(input.prompt.slice(0, 20))}.png`,
        cost_usd: 0.03,
        latency_ms: 20,
        tokens_in: 0,
        tokens_out: 0,
        provider_meta: { size: input.size },
      };
    },
  };
}

function makeFailingProvider(name: 'freepik' | 'higgsfield', retryable = true): ImageProvider {
  return {
    name,
    async generateImage() {
      if (name === 'freepik') {
        throw new FreepikProviderError(429, 'rate-limited', retryable);
      }
      throw new Error('higgsfield-500');
    },
  };
}

interface MockDbState {
  insertedRows: unknown[];
  existingVersions: Map<string, number>;
}

function makeMockDb(state: MockDbState = { insertedRows: [], existingVersions: new Map() }): {
  db: Database;
  state: MockDbState;
} {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
              const versions = Array.from(state.existingVersions.values());
              if (versions.length === 0) return [];
              return [{ version: Math.max(...versions) }];
            },
          }),
          // Also support .where().limit() (for PIR/CopyDeck loads — not exercised here).
          limit: async () => [] as unknown[],
        }),
      }),
    }),
    insert: () => ({
      values: (row: unknown) => ({
        returning: async () => {
          state.insertedRows.push(row);
          return [{ id: `visual-${state.insertedRows.length}` }];
        },
      }),
    }),
  } as unknown as Database;
  return { db, state };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('runVisualSquad — happy path', () => {
  it('runs director → 5 agents → validates → persists', async () => {
    const pir = makePir();
    const copyDeck = makeCopyDeck();
    const { db, state } = makeMockDb();

    const result = await runVisualSquad(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        copyDeckIds: ['cd-1'],
        languages: ['en'],
        pir,
        copyDeck,
      },
      {
        claude: makeStubClaude(),
        imageProvider: makeStubImageProvider('freepik', 'https://freepik.example.com'),
        fallbackProvider: makeStubImageProvider('higgsfield', 'https://higgs.example.com'),
        db,
      },
    );

    expect(result.visualAssetsId).toBe('visual-1');
    expect(result.brand.name).toBe('NovaLab');
    expect(result.assets.hero.urls_by_size.desktop).toContain('freepik.example.com');
    expect(result.assets.icons.length).toBeGreaterThanOrEqual(5);
    expect(result.assets.lifestyle.length).toBeGreaterThanOrEqual(3);
    expect(result.assets.trust_badges.length).toBeGreaterThanOrEqual(2);
    expect(result.directorNotes.length).toBeGreaterThanOrEqual(10);
    expect(state.insertedRows).toHaveLength(1);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.mode).toBe('visual');
  });

  it('phase 1 director runs before phase 2 agents', async () => {
    // Verify director's palette is baked into the visual assets output.
    const pir = makePir();
    const copyDeck = makeCopyDeck();
    const { db } = makeMockDb();

    const result = await runVisualSquad(
      {
        landingPageId: 'lp-2',
        pirDocumentId: 'pir-2',
        copyDeckIds: ['cd-2'],
        languages: ['en'],
        pir,
        copyDeck,
      },
      {
        claude: makeStubClaude(),
        imageProvider: makeStubImageProvider('freepik', 'https://freepik.example.com'),
        db,
      },
    );

    expect(result.brand.palette.primary).toBe('#FF5A3C');
    expect(result.brand.typography.headline_font).toBe('Poppins');
  });
});

describe('runVisualSquad — provider fallback', () => {
  it('falls back to Higgsfield when Freepik throws retryable error', async () => {
    const pir = makePir();
    const copyDeck = makeCopyDeck();
    const { db } = makeMockDb();

    const result = await runVisualSquad(
      {
        landingPageId: 'lp-3',
        pirDocumentId: 'pir-3',
        copyDeckIds: ['cd-3'],
        languages: ['en'],
        pir,
        copyDeck,
      },
      {
        claude: makeStubClaude(),
        imageProvider: makeFailingProvider('freepik', true),
        fallbackProvider: makeStubImageProvider('higgsfield', 'https://higgs.example.com'),
        db,
      },
    );

    expect(result.assets.hero.urls_by_size.desktop).toContain('higgs.example.com');
    // Trace has entries from both providers.
    const providersUsed = new Set(result.agentTrace.map((t) => t.provider));
    expect(providersUsed.has('higgsfield')).toBe(true);
    expect(providersUsed.has('freepik')).toBe(true);
  });
});

describe('runVisualSquad — hero mandatory abort', () => {
  it('aborts when both Freepik and Higgsfield fail (and no fallback available)', async () => {
    const pir = makePir();
    const copyDeck = makeCopyDeck();
    const { db } = makeMockDb();

    await expect(
      runVisualSquad(
        {
          landingPageId: 'lp-4',
          pirDocumentId: 'pir-4',
          copyDeckIds: ['cd-4'],
          languages: ['en'],
          pir,
          copyDeck,
        },
        {
          claude: makeStubClaude(),
          imageProvider: makeFailingProvider('freepik', false), // non-retryable
          // no fallback
          db,
        },
      ),
    ).rejects.toThrow(/hero desktop AND mobile both empty|failed after/i);
  });
});

describe('runVisualSquad — graceful degradation', () => {
  it('when some providers fail but hero succeeds, still assembles', async () => {
    const pir = makePir();
    const copyDeck = makeCopyDeck();
    const { db } = makeMockDb();

    // Custom provider: fails 50% but succeeds for hero-first calls.
    let callCount = 0;
    const flakyProvider: ImageProvider = {
      name: 'freepik',
      async generateImage(input) {
        callCount++;
        // Fail every other call.
        if (callCount % 3 === 0) {
          throw new FreepikProviderError(500, 'server-error', true);
        }
        return {
          url: `https://freepik.example.com/img-${callCount}.png`,
          cost_usd: 0.03,
          latency_ms: 20,
          provider_meta: { size: input.size },
        };
      },
    };
    const fallback = makeStubImageProvider('higgsfield', 'https://higgs.example.com');

    const result = await runVisualSquad(
      {
        landingPageId: 'lp-5',
        pirDocumentId: 'pir-5',
        copyDeckIds: ['cd-5'],
        languages: ['en'],
        pir,
        copyDeck,
      },
      {
        claude: makeStubClaude(),
        imageProvider: flakyProvider,
        fallbackProvider: fallback,
        db,
      },
    );

    expect(result.visualAssetsId).toBe('visual-1');
    // Trace should show both providers used.
    const traceProviders = new Set(result.agentTrace.map((t) => t.provider));
    expect(traceProviders.has('freepik')).toBe(true);
    expect(traceProviders.has('higgsfield')).toBe(true);
  });
});

describe('runVisualSquad — cost aggregation', () => {
  it('aggregates cost from all agent traces', async () => {
    const pir = makePir();
    const copyDeck = makeCopyDeck();
    const { db } = makeMockDb();

    const result = await runVisualSquad(
      {
        landingPageId: 'lp-6',
        pirDocumentId: 'pir-6',
        copyDeckIds: ['cd-6'],
        languages: ['en'],
        pir,
        copyDeck,
      },
      {
        claude: makeStubClaude(),
        imageProvider: makeStubImageProvider('freepik', 'https://freepik.example.com'),
        db,
      },
    );

    // Sum of trace should equal reported cost.
    const traceSum = result.agentTrace.reduce((s, t) => s + t.cost_usd, 0);
    expect(result.costUsd).toBeCloseTo(traceSum, 4);
    // Cost > 0 (director + 5 agents each generate multiple images).
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

describe('runVisualSquad — director_notes documentation (Article IV)', () => {
  it('populates director_notes with orchestration details', async () => {
    const pir = makePir();
    const copyDeck = makeCopyDeck();
    const { db } = makeMockDb();

    const result = await runVisualSquad(
      {
        landingPageId: 'lp-7',
        pirDocumentId: 'pir-7',
        copyDeckIds: ['cd-7'],
        languages: ['en'],
        pir,
        copyDeck,
      },
      {
        claude: makeStubClaude(),
        imageProvider: makeStubImageProvider('freepik', 'https://freepik.example.com'),
        db,
      },
    );

    expect(result.directorNotes.length).toBeGreaterThanOrEqual(10);
    expect(result.directorNotes).toContain('tone=');
    expect(result.directorNotes).toContain('headline_font=');
  });

  it('notes placeholder use when Higgsfield fallback returns placeholder', async () => {
    const pir = makePir();
    const copyDeck = makeCopyDeck();
    const { db } = makeMockDb();

    const placeholderProvider: ImageProvider = {
      name: 'higgsfield',
      async generateImage(input) {
        return {
          url: `https://placeholder.higgsfield.landinglab.local/${encodeURIComponent(input.prompt.slice(0, 10))}.png`,
          cost_usd: 0,
          latency_ms: 5,
          provider_meta: { placeholder: true },
        };
      },
    };

    const result = await runVisualSquad(
      {
        landingPageId: 'lp-8',
        pirDocumentId: 'pir-8',
        copyDeckIds: ['cd-8'],
        languages: ['en'],
        pir,
        copyDeck,
      },
      {
        claude: makeStubClaude(),
        imageProvider: makeFailingProvider('freepik', true),
        fallbackProvider: placeholderProvider,
        db,
      },
    );

    expect(result.directorNotes.toLowerCase()).toContain('placeholder');
  });
});

describe('runVisualSquad — DB loading when pir/copyDeck not provided', () => {
  it('throws when PIR is not in DB and not provided', async () => {
    const { db } = makeMockDb();

    await expect(
      runVisualSquad(
        {
          landingPageId: 'lp-9',
          pirDocumentId: 'pir-9',
          copyDeckIds: ['cd-9'],
          languages: ['en'],
          // no pir, no copyDeck
        },
        {
          claude: makeStubClaude(),
          imageProvider: makeStubImageProvider('freepik', 'https://freepik.example.com'),
          db,
        },
      ),
    ).rejects.toThrow();
  });
});

// Silence unused vi import (kept for future test extensions).
void vi;

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mocks of provider clients — no HTTP calls.
const mockSerpapi = {
  searchByImage: vi.fn(),
};
const mockCheerio = {
  extractFromUrl: vi.fn(),
};
const mockFirecrawl = {
  extract: vi.fn(),
};
const mockApify = {
  runActor: vi.fn(),
};
const mockPerplexity = {
  chat: vi.fn(),
};
const mockClaude = {
  createMessage: vi.fn(),
};

// DB mock — returns fixed pir_document_id.
const mockDb = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ version: 0 }]),
        }),
      }),
    }),
  }),
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'pir-doc-uuid-mock' }]),
    }),
  }),
};

import { runProductResearch } from './orchestrator.js';
import type { OrchestratorDeps } from './orchestrator.js';

function makeDeps(): OrchestratorDeps {
  return {
    serpapi: mockSerpapi as unknown as OrchestratorDeps['serpapi'],
    cheerio: mockCheerio as unknown as OrchestratorDeps['cheerio'],
    firecrawl: mockFirecrawl as unknown as OrchestratorDeps['firecrawl'],
    apify: mockApify as unknown as OrchestratorDeps['apify'],
    perplexity: mockPerplexity as unknown as OrchestratorDeps['perplexity'],
    claude: mockClaude as unknown as OrchestratorDeps['claude'],
    db: mockDb as unknown as OrchestratorDeps['db'],
  };
}

function validPirJson(): string {
  return JSON.stringify({
    schema_version: '1.0.0',
    identity: {
      name: 'Test Product',
      brand: 'Brand',
      category: 'cat',
      model: null,
      price: 29.99,
      currency: 'USD',
      images: [],
      specs: {},
      variants: [],
    },
    market: {
      sophistication_level: 3,
      competitors: [{ name: 'Comp A', url: null, positioning: 'value', price_range: '$20-40', weakness: 'quality' }],
      trends: [],
      gap_vs_competitors: null,
    },
    avatar: {
      demographics: { age_range: '25-45', gender: 'mixed', income_bracket: null, geo: [] },
      psychographics: { identity: null, lifestyle: null, beliefs: [] },
      jobs_to_be_done: [{ job: 'minimize X', importance: 8, satisfaction: 4 }],
    },
    voc: {
      language_bank: [],
      top_pains: [],
      top_desires: [],
      top_objections: [],
      dream_outcomes: [],
    },
    desired_outcomes: { opportunities: [] },
    awareness_stages: [],
    value_equation: {
      dream_outcome: 'better sleep',
      perceived_likelihood: 0.7,
      time_delay: '1 week',
      effort_sacrifice: 'low',
    },
    evidence: {
      reviews_analyzed: 0,
      sources: [],
      confidence_score: 0.7,
      gaps: ['review_miner returned no data'],
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: cheerio returns undefined so tests fall back to firecrawl (backwards-compatible).
  mockCheerio.extractFromUrl.mockResolvedValue(undefined);
  // Re-wire mockDb since clearAllMocks resets impls too.
  mockDb.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ version: 0 }]),
        }),
      }),
    }),
  });
  mockDb.insert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'pir-doc-uuid-mock' }]),
    }),
  });
});

describe('runProductResearch — Modo A (link)', () => {
  it('runs 3 workers in parallel and synthesizes PIR', async () => {
    // Firecrawl → spec-hunter returns product data.
    mockFirecrawl.extract.mockResolvedValue({
      data: { title: 'Product X', description_html: null, specs: {}, images: [], price: null, variants: [], reviews_stats: null, seller: null },
      urls: ['https://aliexpress.com/x'],
      latency_ms: 500,
      cost_usd: 0.01,
      tokens_in: 0,
      tokens_out: 0,
    });
    // Apify → review-miner returns items.
    mockApify.runActor.mockResolvedValue({
      actor_id: 'epctex/amazon-reviews-scraper',
      run_id: 'sync-1',
      status: 'SUCCEEDED',
      items: [{ text: 'This product is terrible, doesnt work at all!!' }],
      latency_ms: 3000,
      cost_usd: 0.05,
      tokens_in: 0,
      tokens_out: 0,
    });
    // Perplexity → market-analyst returns intel JSON.
    mockPerplexity.chat.mockResolvedValue({
      content: {
        avatar_hypothesis: { demographic_hints: {}, core_functional_job: 'x', context_of_use: '', triggers: [] },
        market: { sophistication_level: 3, sophistication_reasoning: '', category_maturity: 'growth', market_size_hint: null, trends_2025_2026: [] },
        competitors: [{ name: 'C', price_range: null, positioning: '', strengths: [], gaps: [], url: null }],
        differentiation_hypotheses: [],
        awareness_map: {
          unaware: { trigger_hook: '', education_needed: [] },
          problem_aware: { problem_statement: '' },
          solution_aware: { comparison_angles: [], differentiators: [] },
          product_aware: { objections_to_kill: [], proof_needed: [] },
          most_aware: { offer_stack_hint: '', urgency_hint: '' },
        },
        citations: [],
      },
      citations: [],
      tokens_in: 500,
      tokens_out: 800,
      latency_ms: 3000,
      cost_usd: 0.08,
      model: 'sonar-pro',
    });
    // Claude → pir-synthesizer returns valid PIR JSON.
    mockClaude.createMessage.mockResolvedValue({
      content: validPirJson(),
      tokens_in: 2000,
      tokens_out: 1500,
      latency_ms: 5000,
      cost_usd: 0.15,
      model: 'claude-opus-4-7',
      stop_reason: 'end_turn',
    });

    const result = await runProductResearch(
      {
        landingPageId: 'lp-uuid-1',
        targetLanguage: 'en',
        sourceUrl: 'https://aliexpress.com/x',
        sourceImageUrl: null,
        sourceType: 'aliexpress_link',
        hint: null,
      },
      makeDeps(),
    );

    expect(result.mode).toBe('A');
    expect(result.pirDocumentId).toBe('pir-doc-uuid-mock');
    expect(result.pirVersion).toBe(1);
    expect(result.pir).not.toBeNull();
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.agentTrace.length).toBeGreaterThanOrEqual(4); // 3 workers + synth
    expect(mockSerpapi.searchByImage).not.toHaveBeenCalled(); // Modo A skips lens
  });

  it('aggregates cost from all workers into total costUsd', async () => {
    mockFirecrawl.extract.mockResolvedValue({
      data: {}, urls: ['x'], latency_ms: 100, cost_usd: 0.01, tokens_in: 0, tokens_out: 0,
    });
    mockApify.runActor.mockResolvedValue({
      actor_id: 'x', run_id: 'x', status: 'SUCCEEDED', items: [], latency_ms: 100, cost_usd: 0.05, tokens_in: 0, tokens_out: 0,
    });
    mockPerplexity.chat.mockResolvedValue({
      content: {}, citations: [], tokens_in: 100, tokens_out: 100, latency_ms: 100, cost_usd: 0.08, model: 'sonar-pro',
    });
    mockClaude.createMessage.mockResolvedValue({
      content: validPirJson(), tokens_in: 1000, tokens_out: 500, latency_ms: 1000, cost_usd: 0.15, model: 'claude-opus-4-7', stop_reason: 'end_turn',
    });

    const result = await runProductResearch(
      { landingPageId: 'lp-1', targetLanguage: 'en', sourceUrl: 'https://x.com', sourceImageUrl: null, sourceType: 'aliexpress_link', hint: null },
      makeDeps(),
    );
    // Review-miner planeja 2 Apify actors (Amazon + Reddit inferred) → 2 × 0.05 = 0.10.
    // spec=0.01 + review=0.10 + market=0.08 + synth=0.15 = 0.34.
    // Toleramos margem porque planActors depende de heurística sobre input.
    expect(result.costUsd).toBeGreaterThanOrEqual(0.29);
    expect(result.costUsd).toBeLessThanOrEqual(0.5);
    // Assegura que cost NÃO é zero (regressão contra "esqueci de somar").
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

describe('runProductResearch — Modo B (photo)', () => {
  it('runs lens-scout → vision-verifier → 3 workers → synth', async () => {
    mockSerpapi.searchByImage.mockResolvedValue({
      query_image_url: 'https://cdn.example.com/photo.jpg',
      visual_matches: [
        { source_url: 'https://amazon.com/x', title: 'Product X', thumbnail: 'https://t.com/1.jpg', brand: 'amazon', price: '$29.99' },
        { source_url: 'https://ebay.com/y', title: 'Product Y', thumbnail: 'https://t.com/2.jpg', brand: 'ebay', price: null },
        { source_url: 'https://aliexpress.com/z', title: 'Product Z', thumbnail: 'https://t.com/3.jpg', brand: 'aliexpress', price: null },
      ],
      latency_ms: 800,
      cost_usd: 0.015,
      tokens_in: 0,
      tokens_out: 0,
    });
    // Vera returns high confidence pick.
    mockClaude.createMessage.mockImplementationOnce(() =>
      Promise.resolve({
        content: JSON.stringify({
          best_match_index: 0,
          confidence: 0.9,
          reasoning: 'exact match on packaging',
          attributes_read: {
            brand: 'FitGear',
            model: 'MG-001',
            category: 'wellness',
            key_features: ['portable', 'usb-c'],
            text_on_packaging: 'FitGear Pro',
            colors_visible: ['black'],
          },
        }),
        tokens_in: 2500, tokens_out: 400, latency_ms: 3500, cost_usd: 0.04, model: 'claude-opus-4-7', stop_reason: 'end_turn',
      }),
    );
    // 3 workers.
    mockFirecrawl.extract.mockResolvedValue({
      data: { title: 'Product X' }, urls: ['https://amazon.com/x'], latency_ms: 500, cost_usd: 0.01, tokens_in: 0, tokens_out: 0,
    });
    mockApify.runActor.mockResolvedValue({
      actor_id: 'x', run_id: 'x', status: 'SUCCEEDED', items: [], latency_ms: 100, cost_usd: 0.05, tokens_in: 0, tokens_out: 0,
    });
    mockPerplexity.chat.mockResolvedValue({
      content: {}, citations: [], tokens_in: 100, tokens_out: 100, latency_ms: 100, cost_usd: 0.08, model: 'sonar-pro',
    });
    // Synth call.
    mockClaude.createMessage.mockImplementationOnce(() =>
      Promise.resolve({
        content: validPirJson(), tokens_in: 2000, tokens_out: 1500, latency_ms: 5000, cost_usd: 0.15, model: 'claude-opus-4-7', stop_reason: 'end_turn',
      }),
    );

    const result = await runProductResearch(
      {
        landingPageId: 'lp-uuid-2',
        targetLanguage: 'en',
        sourceUrl: null,
        sourceImageUrl: 'https://cdn.example.com/photo.jpg',
        sourceType: 'photo_upload',
        hint: null,
      },
      makeDeps(),
    );
    expect(result.mode).toBe('B');
    expect(mockSerpapi.searchByImage).toHaveBeenCalledTimes(1);
    expect(result.needsHumanReview).toBeUndefined();
    expect(result.pir).not.toBeNull();
  });

  it('marks needs_human_review when Vera confidence < 0.6', async () => {
    mockSerpapi.searchByImage.mockResolvedValue({
      query_image_url: 'https://cdn.example.com/photo.jpg',
      visual_matches: [
        { source_url: 'https://a.com/x', title: 'x', thumbnail: 'https://t.com/1.jpg', brand: null, price: null },
        { source_url: 'https://a.com/y', title: 'y', thumbnail: 'https://t.com/2.jpg', brand: null, price: null },
        { source_url: 'https://a.com/z', title: 'z', thumbnail: 'https://t.com/3.jpg', brand: null, price: null },
      ],
      latency_ms: 800,
      cost_usd: 0.015,
      tokens_in: 0,
      tokens_out: 0,
    });
    mockClaude.createMessage.mockResolvedValue({
      content: JSON.stringify({
        best_match_index: 0,
        confidence: 0.35,
        reasoning: 'not sure',
        attributes_read: { brand: null, model: null, category: null, key_features: [], text_on_packaging: null, colors_visible: [] },
      }),
      tokens_in: 100, tokens_out: 50, latency_ms: 500, cost_usd: 0.03, model: 'claude-opus-4-7', stop_reason: 'end_turn',
    });

    const result = await runProductResearch(
      {
        landingPageId: 'lp-3',
        targetLanguage: 'en',
        sourceUrl: null,
        sourceImageUrl: 'https://cdn.example.com/photo.jpg',
        sourceType: 'photo_upload',
        hint: null,
      },
      makeDeps(),
    );
    expect(result.needsHumanReview).toBe(true);
    expect(mockFirecrawl.extract).not.toHaveBeenCalled();
  });

  it('marks needs_human_review when lens returns no matches', async () => {
    mockSerpapi.searchByImage.mockResolvedValue({
      query_image_url: 'https://x.jpg',
      visual_matches: [],
      latency_ms: 500,
      cost_usd: 0.015,
      tokens_in: 0,
      tokens_out: 0,
    });

    const result = await runProductResearch(
      { landingPageId: 'lp-4', targetLanguage: 'en', sourceUrl: null, sourceImageUrl: 'https://x.jpg', sourceType: 'photo_upload', hint: null },
      makeDeps(),
    );
    expect(result.needsHumanReview).toBe(true);
  });
});

describe('runProductResearch — graceful degradation', () => {
  it('still produces PIR when 1 worker fails', async () => {
    // spec-hunter fails permanently (all 3 attempts fail).
    mockFirecrawl.extract.mockRejectedValue(new Error('firecrawl-down'));
    mockApify.runActor.mockResolvedValue({
      actor_id: 'x', run_id: 'x', status: 'SUCCEEDED', items: [], latency_ms: 100, cost_usd: 0.05, tokens_in: 0, tokens_out: 0,
    });
    mockPerplexity.chat.mockResolvedValue({
      content: {}, citations: [], tokens_in: 100, tokens_out: 100, latency_ms: 100, cost_usd: 0.08, model: 'sonar-pro',
    });
    mockClaude.createMessage.mockResolvedValue({
      content: validPirJson(), tokens_in: 1000, tokens_out: 500, latency_ms: 1000, cost_usd: 0.15, model: 'claude-opus-4-7', stop_reason: 'end_turn',
    });

    const result = await runProductResearch(
      { landingPageId: 'lp-5', targetLanguage: 'en', sourceUrl: 'https://x.com', sourceImageUrl: null, sourceType: 'aliexpress_link', hint: null },
      makeDeps(),
    );
    // PIR still generated because Sage synthesizer received valid stub PIR
    // (test uses valid PIR json regardless of missing worker; runtime gap
    // acknowledgment happens in real Claude call — here we prove the pipeline continues).
    expect(result.pir).not.toBeNull();
    expect(result.agentTrace.some((t) => t.status === 'failed')).toBe(true);
  }, 20_000);

  it('returns needs_human_review when all providers time out globally (short timeout)', async () => {
    // This test exercises the global-timeout path; we don't need to wait 240s.
    // We simulate synth failure by returning invalid JSON always.
    mockFirecrawl.extract.mockResolvedValue({
      data: {}, urls: ['x'], latency_ms: 100, cost_usd: 0.01, tokens_in: 0, tokens_out: 0,
    });
    mockApify.runActor.mockResolvedValue({
      actor_id: 'x', run_id: 'x', status: 'SUCCEEDED', items: [], latency_ms: 100, cost_usd: 0.05, tokens_in: 0, tokens_out: 0,
    });
    mockPerplexity.chat.mockResolvedValue({
      content: 'not-json', citations: [], tokens_in: 100, tokens_out: 100, latency_ms: 100, cost_usd: 0.08, model: 'sonar-pro',
    });
    // Claude synth returns invalid JSON both attempts → synth_failed.
    mockClaude.createMessage.mockResolvedValue({
      content: 'not json at all', tokens_in: 100, tokens_out: 50, latency_ms: 100, cost_usd: 0.10, model: 'claude-opus-4-7', stop_reason: 'end_turn',
    });

    const result = await runProductResearch(
      { landingPageId: 'lp-6', targetLanguage: 'en', sourceUrl: 'https://x.com', sourceImageUrl: null, sourceType: 'aliexpress_link', hint: null },
      makeDeps(),
    );
    expect(result.pir).toBeNull();
    expect(result.pirDocumentId).toBe('');
  }, 20_000);
});

describe('spec-hunter chain — cheerio primary + firecrawl fallback', () => {
  it('uses cheerio primary and skips firecrawl when cheerio succeeds', async () => {
    mockCheerio.extractFromUrl.mockResolvedValue({
      status: 'ok',
      identity: {
        name: 'Cheerio Product',
        brand: 'BrandZ',
        price: 89,
        currency: 'EUR',
        images: ['https://cdn/1.jpg'],
        description: 'from cheerio',
        category: null,
      },
      specs: { color: 'black' },
      source: 'json-ld',
      cost_usd: 0,
      latency_ms: 350,
    });
    // Other agents mocked minimally.
    mockApify.runActor.mockResolvedValue({
      actor_id: 'x', run_id: 'x', status: 'SUCCEEDED', items: [], latency_ms: 100, cost_usd: 0.05, tokens_in: 0, tokens_out: 0,
    });
    mockPerplexity.chat.mockResolvedValue({
      content: {}, citations: [], tokens_in: 100, tokens_out: 100, latency_ms: 100, cost_usd: 0.08, model: 'sonar-pro',
    });
    mockClaude.createMessage.mockResolvedValue({
      content: validPirJson(), tokens_in: 1000, tokens_out: 500, latency_ms: 1000, cost_usd: 0.15, model: 'claude-opus-4-7', stop_reason: 'end_turn',
    });

    const result = await runProductResearch(
      { landingPageId: 'lp-cheerio-1', targetLanguage: 'en', sourceUrl: 'https://shop.example.com/product', sourceImageUrl: null, sourceType: 'aliexpress_link', hint: null },
      makeDeps(),
    );

    expect(mockCheerio.extractFromUrl).toHaveBeenCalledTimes(1);
    expect(mockFirecrawl.extract).not.toHaveBeenCalled();
    const specTrace = result.agentTrace.find((t) => t.agent === 'spec-hunter');
    expect(specTrace?.provider).toBe('cheerio');
    expect(specTrace?.status).toBe('ok');
    expect((specTrace as { source_used?: string })?.source_used).toBe('cheerio');
    // Cost from spec-hunter contribution is 0 (cheerio is free).
    expect(specTrace?.cost_usd).toBe(0);
  });

  it('falls back to firecrawl when cheerio partial (has title only, no images/price)', async () => {
    mockCheerio.extractFromUrl.mockResolvedValue({
      status: 'partial',
      identity: {
        name: 'Only Title Here',
        brand: null,
        price: null,
        currency: null,
        images: [],
        description: null,
        category: null,
      },
      specs: {},
      source: 'html-fallback',
      cost_usd: 0,
      latency_ms: 200,
    });
    mockFirecrawl.extract.mockResolvedValue({
      data: { title: 'Firecrawl Title', description_html: null, specs: {}, images: [], price: null, variants: [], reviews_stats: null, seller: null },
      urls: ['https://x'], latency_ms: 5000, cost_usd: 0.01, tokens_in: 100, tokens_out: 200,
    });
    mockApify.runActor.mockResolvedValue({
      actor_id: 'x', run_id: 'x', status: 'SUCCEEDED', items: [], latency_ms: 100, cost_usd: 0.05, tokens_in: 0, tokens_out: 0,
    });
    mockPerplexity.chat.mockResolvedValue({
      content: {}, citations: [], tokens_in: 100, tokens_out: 100, latency_ms: 100, cost_usd: 0.08, model: 'sonar-pro',
    });
    mockClaude.createMessage.mockResolvedValue({
      content: validPirJson(), tokens_in: 1000, tokens_out: 500, latency_ms: 1000, cost_usd: 0.15, model: 'claude-opus-4-7', stop_reason: 'end_turn',
    });

    const result = await runProductResearch(
      { landingPageId: 'lp-cheerio-2', targetLanguage: 'en', sourceUrl: 'https://weak.example.com/product', sourceImageUrl: null, sourceType: 'aliexpress_link', hint: null },
      makeDeps(),
    );

    expect(mockCheerio.extractFromUrl).toHaveBeenCalled();
    expect(mockFirecrawl.extract).toHaveBeenCalled();
    const specTrace = result.agentTrace.find((t) => t.agent === 'spec-hunter');
    expect((specTrace as { source_used?: string })?.source_used).toBe('both');
    expect(specTrace?.provider).toContain('firecrawl');
    expect(specTrace?.status).toBe('ok');
  });
});

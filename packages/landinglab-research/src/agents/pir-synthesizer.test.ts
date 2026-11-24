import { describe, expect, it, vi, beforeEach } from 'vitest';

import { runPirSynthesizer } from './pir-synthesizer.js';
import type { ClaudeVisionClient } from '../providers/claude-vision.js';

function validPirJson(
  gaps: string[] = ['review_miner returned no items'],
  overrides: { name?: string; confidence_score?: number } = {},
): string {
  return JSON.stringify({
    schema_version: '1.0.0',
    identity: {
      name: overrides.name ?? 'Test Product',
      brand: null,
      category: null,
      model: null,
      price: null,
      currency: null,
      images: [],
      specs: {},
      variants: [],
    },
    market: {
      sophistication_level: 3,
      competitors: [],
      trends: [],
      gap_vs_competitors: null,
    },
    avatar: {
      demographics: { age_range: null, gender: 'unknown', income_bracket: null, geo: [] },
      psychographics: { identity: null, lifestyle: null, beliefs: [] },
      jobs_to_be_done: [],
    },
    voc: { language_bank: [], top_pains: [], top_desires: [], top_objections: [], dream_outcomes: [] },
    desired_outcomes: { opportunities: [] },
    awareness_stages: [],
    value_equation: {
      dream_outcome: 'x', perceived_likelihood: 0.5, time_delay: '1w', effort_sacrifice: 'low',
    },
    evidence: {
      reviews_analyzed: 0,
      sources: [],
      // Default 0.8: acima do CONFIDENCE_BLOCK_THRESHOLD (0.6) do Bug #10 gate.
      // Tests que exercitam o gate passam confidence_score explicitamente.
      confidence_score: overrides.confidence_score ?? 0.8,
      gaps,
    },
  });
}

function makeMockDb(existingVersion = 0, insertedId = 'inserted-uuid') {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(existingVersion > 0 ? [{ version: existingVersion }] : []),
          }),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: insertedId }]),
      }),
    }),
  };
}

function makeClaude(responses: Array<{ content: string }>): ClaudeVisionClient {
  const responseQueue = [...responses];
  return {
    createMessage: vi.fn(async () => {
      const r = responseQueue.shift() ?? responses[responses.length - 1]!;
      return {
        content: r.content,
        tokens_in: 1000,
        tokens_out: 500,
        latency_ms: 1000,
        cost_usd: 0.1,
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn' as const,
      };
    }),
  } as unknown as ClaudeVisionClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runPirSynthesizer', () => {
  it('successfully synthesizes and persists a valid PIR', async () => {
    const claude = makeClaude([{ content: validPirJson() }]);
    const db = makeMockDb();
    const result = await runPirSynthesizer(
      {
        landingPageId: 'lp-uuid',
        targetLanguage: 'en',
        workerOutputs: { spec_hunter: null, review_miner: null, market_analyst: null },
      },
      { claude, db: db as never },
    );
    expect(result.data).not.toBeNull();
    expect(result.data?.pirDocumentId).toBe('inserted-uuid');
    expect(result.data?.pirVersion).toBe(1);
    expect(result.trace.status).toBe('ok');
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('increments version when previous PIR exists', async () => {
    const claude = makeClaude([{ content: validPirJson() }]);
    const db = makeMockDb(3, 'inserted-v4');
    const result = await runPirSynthesizer(
      {
        landingPageId: 'lp-uuid',
        targetLanguage: 'en',
        workerOutputs: { spec_hunter: null, review_miner: null, market_analyst: null },
      },
      { claude, db: db as never },
    );
    expect(result.data?.pirVersion).toBe(4);
  });

  it('retries once on invalid Zod (empty gaps) and succeeds on 2nd attempt', async () => {
    // 1st: invalid (empty gaps → rejected by validatePir).
    // 2nd: valid.
    const claude = makeClaude([
      { content: validPirJson([]) },
      { content: validPirJson(['review_miner returned nothing']) },
    ]);
    const db = makeMockDb();
    const result = await runPirSynthesizer(
      {
        landingPageId: 'lp-uuid',
        targetLanguage: 'en',
        workerOutputs: { spec_hunter: null, review_miner: null, market_analyst: null },
      },
      { claude, db: db as never },
    );
    expect(result.data).not.toBeNull();
    expect((claude.createMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('fails after 2 attempts of invalid JSON', async () => {
    const claude = makeClaude([
      { content: 'not json' },
      { content: 'still not json' },
    ]);
    const db = makeMockDb();
    const result = await runPirSynthesizer(
      {
        landingPageId: 'lp-uuid',
        targetLanguage: 'en',
        workerOutputs: { spec_hunter: null, review_miner: null, market_analyst: null },
      },
      { claude, db: db as never },
    );
    expect(result.data).toBeNull();
    expect(result.trace.status).toBe('failed');
    expect(db.insert).not.toHaveBeenCalled();
  });

  // ── Bug #10 gate: block Squad 2 dispatch quando identity é placeholder ──
  it('sets needsHumanReview=true when identity.name is "Unknown Product"', async () => {
    const claude = makeClaude([{ content: validPirJson(['gap'], { name: 'Unknown Product' }) }]);
    const db = makeMockDb();
    const result = await runPirSynthesizer(
      {
        landingPageId: 'lp-uuid',
        targetLanguage: 'en',
        workerOutputs: { spec_hunter: null, review_miner: null, market_analyst: null },
      },
      { claude, db: db as never },
    );
    expect(result.data).not.toBeNull();
    expect(result.data?.needsHumanReview).toBe(true);
    expect(result.data?.blockDownstreamReason).toContain('Unknown Product');
    // PIR ainda é persistido (auditoria + humano completa depois).
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(result.trace.status).toBe('partial');
  });

  it('sets needsHumanReview=true when identity.name contains "unknown" (case-insensitive)', async () => {
    const claude = makeClaude([{ content: validPirJson(['gap'], { name: 'unknown gadget' }) }]);
    const db = makeMockDb();
    const result = await runPirSynthesizer(
      {
        landingPageId: 'lp-uuid',
        targetLanguage: 'en',
        workerOutputs: { spec_hunter: null, review_miner: null, market_analyst: null },
      },
      { claude, db: db as never },
    );
    expect(result.data?.needsHumanReview).toBe(true);
  });

  it('sets needsHumanReview=true when confidence_score < 0.5', async () => {
    const claude = makeClaude([{ content: validPirJson(['gap'], { confidence_score: 0.4 }) }]);
    const db = makeMockDb();
    const result = await runPirSynthesizer(
      {
        landingPageId: 'lp-uuid',
        targetLanguage: 'en',
        workerOutputs: { spec_hunter: null, review_miner: null, market_analyst: null },
      },
      { claude, db: db as never },
    );
    expect(result.data?.needsHumanReview).toBe(true);
    expect(result.data?.blockDownstreamReason).toContain('0.40');
  });

  it('does NOT set needsHumanReview when identity valid and confidence >= 0.6', async () => {
    const claude = makeClaude([
      { content: validPirJson(['gap'], { name: 'Parijan Pillow', confidence_score: 0.75 }) },
    ]);
    const db = makeMockDb();
    const result = await runPirSynthesizer(
      {
        landingPageId: 'lp-uuid',
        targetLanguage: 'en',
        workerOutputs: { spec_hunter: null, review_miner: null, market_analyst: null },
      },
      { claude, db: db as never },
    );
    expect(result.data?.needsHumanReview).toBeUndefined();
    expect(result.data?.blockDownstreamReason).toBeUndefined();
    expect(result.trace.status).toBe('ok');
  });

  it('aggregates tokens+cost across both attempts on retry', async () => {
    const claude = makeClaude([
      { content: validPirJson([]) },
      { content: validPirJson(['valid gap']) },
    ]);
    const db = makeMockDb();
    const result = await runPirSynthesizer(
      {
        landingPageId: 'lp-uuid',
        targetLanguage: 'en',
        workerOutputs: { spec_hunter: null, review_miner: null, market_analyst: null },
      },
      { claude, db: db as never },
    );
    // Each call: tokens_in=1000, tokens_out=500, cost=0.1. 2 calls total.
    expect(result.trace.tokens_in).toBe(2000);
    expect(result.trace.tokens_out).toBe(1000);
    expect(result.trace.cost_usd).toBeCloseTo(0.2, 2);
  });
});

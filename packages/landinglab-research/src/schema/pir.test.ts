import { describe, expect, it } from 'vitest';

import { calcOpportunityScore, PirValidationError, pirSchema, validatePir } from './pir.js';

function makeValidPir(): Record<string, unknown> {
  return {
    schema_version: '1.0.0',
    identity: {
      name: 'Massage Gun Pro',
      brand: 'FitGear',
      category: 'wellness',
      model: 'MG-001',
      price: 79.99,
      currency: 'USD',
      images: ['https://cdn.example.com/img1.jpg'],
      specs: { battery: '2000mAh', weight: '1.2kg' },
      variants: [{ name: 'Color', value: 'Black' }],
    },
    market: {
      sophistication_level: 4,
      competitors: [
        { name: 'Theragun Mini', url: null, positioning: 'premium', price_range: '$199', weakness: 'price' },
      ],
      trends: ['recovery boom 2026'],
      gap_vs_competitors: 'sub-$100 pricing with pro features',
    },
    avatar: {
      demographics: {
        age_range: '25-45',
        gender: 'mixed',
        income_bracket: '$40k-$80k',
        geo: ['US', 'DE'],
      },
      psychographics: {
        identity: 'active professional',
        lifestyle: 'weekend athlete',
        beliefs: ['recovery matters'],
      },
      jobs_to_be_done: [
        { job: 'minimize post-workout soreness', importance: 9, satisfaction: 5 },
      ],
    },
    voc: {
      language_bank: ['saved my back'],
      top_pains: [
        {
          pain: 'chronic tightness',
          frequency: 12,
          intensity: 8,
          verbatim: ['tightness in my neck'],
        },
      ],
      top_desires: [{ desire: 'sleep through the night', frequency: 6, verbatim: [] }],
      top_objections: [{ objection: 'too cheap to work', frequency: 3, verbatim: [] }],
      dream_outcomes: ['pain-free mornings'],
    },
    desired_outcomes: {
      opportunities: [
        { outcome: 'minimize soreness time', importance: 9, satisfaction: 5, opportunity_score: 13 },
      ],
    },
    awareness_stages: [
      {
        stage: 'problem_aware',
        trigger_hook: 'you woke up sore again',
        education_needed: null,
        objections_to_kill: ['massage guns dont work'],
        proof_needed: ['before/after'],
      },
    ],
    value_equation: {
      dream_outcome: 'no more morning stiffness',
      perceived_likelihood: 0.8,
      time_delay: '3 days',
      effort_sacrifice: '5 min per day',
    },
    evidence: {
      reviews_analyzed: 87,
      sources: [
        { agent: 'review-miner', provider: 'apify', url: 'https://amazon.com/x', cited_for: 'top_pains' },
      ],
      confidence_score: 0.82,
      gaps: ['competitor pricing for LATAM region not verified'],
    },
  };
}

describe('pirSchema', () => {
  describe('validatePir', () => {
    it('accepts a fully valid PIR', () => {
      const pir = makeValidPir();
      const result = validatePir(pir);
      expect(result.identity.name).toBe('Massage Gun Pro');
      expect(result.evidence.gaps.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects PIR with empty evidence.gaps (Article IV enforcement)', () => {
      const pir = makeValidPir();
      (pir['evidence'] as { gaps: string[] }).gaps = [];
      expect(() => validatePir(pir)).toThrow(PirValidationError);
    });

    it('rejects PIR with placeholder-short gap descriptions', () => {
      const pir = makeValidPir();
      (pir['evidence'] as { gaps: string[] }).gaps = ['ok'];
      expect(() => validatePir(pir)).toThrow(PirValidationError);
    });

    it('rejects PIR missing required identity.name', () => {
      const pir = makeValidPir();
      (pir['identity'] as { name?: string }).name = undefined;
      expect(() => validatePir(pir)).toThrow(PirValidationError);
    });

    it('rejects PIR with sophistication_level out of range', () => {
      const pir = makeValidPir();
      (pir['market'] as { sophistication_level: number }).sophistication_level = 7;
      expect(() => validatePir(pir)).toThrow(PirValidationError);
    });

    it('exposes issues array on PirValidationError', () => {
      const pir = makeValidPir();
      (pir['evidence'] as { gaps: string[] }).gaps = [];
      try {
        validatePir(pir);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PirValidationError);
        expect((err as PirValidationError).issues).toBeInstanceOf(Array);
      }
    });
  });

  describe('pirSchema.safeParse', () => {
    it('parses valid PIR successfully', () => {
      const res = pirSchema.safeParse(makeValidPir());
      expect(res.success).toBe(true);
    });

    it('fills defaults for optional fields', () => {
      const pir = makeValidPir();
      // Remove voc arrays to test defaults.
      (pir['voc'] as Record<string, unknown>)['top_pains'] = undefined;
      const res = pirSchema.safeParse(pir);
      expect(res.success).toBe(true);
    });
  });
});

describe('calcOpportunityScore', () => {
  it('returns importance when satisfaction >= importance', () => {
    expect(calcOpportunityScore(8, 10)).toBe(8);
    expect(calcOpportunityScore(5, 5)).toBe(5);
  });

  it('adds gap when importance > satisfaction', () => {
    expect(calcOpportunityScore(9, 4)).toBe(9 + 5);
    expect(calcOpportunityScore(10, 0)).toBe(20);
  });

  it('handles minimum boundary (importance 1, satisfaction 1)', () => {
    expect(calcOpportunityScore(1, 1)).toBe(1);
  });
});

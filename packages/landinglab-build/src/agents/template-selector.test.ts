// Story 13.6 AC28 (Wave 2) — Template Selector rule engine tests.

import { describe, expect, it } from 'vitest';
import type { Pir } from '@blackshop/landinglab-research';

import { selectTemplate } from './template-selector.js';

function makePir(overrides: Partial<Pir> = {}): Pir {
  const base: Pir = {
    schema_version: '1.0.0',
    identity: {
      name: 'Sample',
      brand: null,
      category: null,
      model: null,
      price: 19.99,
      currency: 'USD',
      images: [],
      specs: {},
      variants: [],
    },
    market: {
      sophistication_level: 1,
      competitors: [],
      trends: [],
      gap_vs_competitors: null,
    },
    avatar: {
      demographics: { age_range: null, gender: 'unknown', income_bracket: null, geo: [] },
      psychographics: { identity: null, lifestyle: null, beliefs: [] },
      jobs_to_be_done: [],
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
      dream_outcome: 'feel great',
      perceived_likelihood: 0.7,
      time_delay: '1 week',
      effort_sacrifice: 'minimal',
    },
    evidence: { reviews_analyzed: 0, sources: [], confidence_score: 0.7, gaps: ['gap-1'] },
  };
  return { ...base, ...overrides } as Pir;
}

describe('selectTemplate', () => {
  it('picks long-form-advertorial for sophistication 4 + electronics category', () => {
    const pir = makePir({
      identity: { ...makePir().identity, category: 'electronics' },
      market: { sophistication_level: 4, competitors: [], trends: [], gap_vs_competitors: null },
    });
    const { templateName, reasoning } = selectTemplate(pir);
    expect(templateName).toBe('long-form-advertorial');
    expect(reasoning).toContain('sophistication');
    expect(reasoning).toContain('electronics');
  });

  it('picks long-form-advertorial for sophistication 5 + supplements', () => {
    const pir = makePir({
      identity: { ...makePir().identity, category: 'supplements' },
      market: { sophistication_level: 5, competitors: [], trends: [], gap_vs_competitors: null },
    });
    expect(selectTemplate(pir).templateName).toBe('long-form-advertorial');
  });

  it('picks story-driven for pain intensity 9 (even if sophistication low)', () => {
    const pir = makePir({
      voc: {
        language_bank: [],
        top_pains: [{ pain: 'chronic', frequency: 100, intensity: 9, verbatim: [] }],
        top_desires: [],
        top_objections: [],
        dream_outcomes: [],
      },
    });
    const { templateName, reasoning } = selectTemplate(pir);
    expect(templateName).toBe('story-driven');
    expect(reasoning).toContain('emotional intensity');
  });

  it('picks story-driven for 4 beliefs in psychographics (rich profile)', () => {
    const pir = makePir({
      avatar: {
        demographics: { age_range: null, gender: 'unknown', income_bracket: null, geo: [] },
        psychographics: {
          identity: null,
          lifestyle: null,
          beliefs: ['b1', 'b2', 'b3', 'b4'],
        },
        jobs_to_be_done: [],
      },
    });
    expect(selectTemplate(pir).templateName).toBe('story-driven');
  });

  it('picks short-form-direct for sophistication 1 + no signals', () => {
    const pir = makePir({
      market: { sophistication_level: 1, competitors: [], trends: [], gap_vs_competitors: null },
    });
    expect(selectTemplate(pir).templateName).toBe('short-form-direct');
  });

  it('picks short-form-direct by default (fallback)', () => {
    const pir = makePir({
      identity: { ...makePir().identity, category: 'apparel' },
      market: { sophistication_level: 2, competitors: [], trends: [], gap_vs_competitors: null },
    });
    expect(selectTemplate(pir).templateName).toBe('short-form-direct');
  });

  it('long-form rule requires BOTH sophistication AND complex category', () => {
    // High sophistication alone (unknown category) → not long-form
    const pir = makePir({
      identity: { ...makePir().identity, category: 'apparel' },
      market: { sophistication_level: 5, competitors: [], trends: [], gap_vs_competitors: null },
    });
    const result = selectTemplate(pir);
    expect(result.templateName).not.toBe('long-form-advertorial');
  });

  it('reasoning string is always populated (audit trail)', () => {
    const pir = makePir();
    const { reasoning } = selectTemplate(pir);
    expect(reasoning.length).toBeGreaterThan(15);
  });
});

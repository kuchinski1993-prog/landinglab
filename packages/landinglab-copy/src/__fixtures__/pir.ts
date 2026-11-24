// Shared fixtures for orchestrator + copy-chief tests.
//
// Real PIR shape (matches packages/landinglab-research/src/schema/pir.ts).
// Not overly rich — just enough to drive Chief's fallback logic + coherence
// validation. Test files can extend/mutate as needed.

import type { Pir } from '@blackshop/landinglab-research';

export function makeValidPir(overrides: Partial<Pir> = {}): Pir {
  return {
    schema_version: '1.0.0',
    identity: {
      name: 'Posture Reset Smart Brace',
      brand: 'PostureCo',
      category: 'wearable_health',
      model: 'PR-100',
      price: 49,
      currency: 'USD',
      images: [],
      specs: {},
      variants: [],
      ...overrides.identity,
    },
    market: {
      sophistication_level: 3,
      competitors: [
        {
          name: 'BackFix Pro',
          url: null,
          positioning: 'medical-grade',
          price_range: '$79-129',
          weakness: 'requires prescription',
        },
      ],
      trends: ['wfh ergonomics', 'wearables'],
      gap_vs_competitors: 'no smart-brace under $50',
      ...overrides.market,
    },
    avatar: {
      demographics: {
        age_range: '30-55',
        gender: 'mixed',
        income_bracket: '$40k-$100k',
        geo: ['US', 'UK'],
      },
      psychographics: {
        identity: 'desk-worker who values self-care',
        lifestyle: 'sedentary weekdays, active weekends',
        beliefs: ['prevention > pills'],
      },
      jobs_to_be_done: [
        { job: 'minimize the time it takes to reduce upper-back pain', importance: 9, satisfaction: 3 },
        { job: 'avoid taking pain medication daily', importance: 8, satisfaction: 4 },
      ],
      ...overrides.avatar,
    },
    voc: {
      language_bank: [
        'my back was killing me by 3pm every single day',
        "I don't want to take pills anymore",
        'chiropractor is too expensive to do weekly',
        'nothing else has worked',
        'I need something I can wear at my desk',
      ],
      top_pains: [
        {
          pain: 'chronic upper-back pain from desk work',
          frequency: 42,
          intensity: 8,
          verbatim: ['my back was killing me by 3pm every single day'],
        },
      ],
      top_desires: [
        {
          desire: 'pain-free workday without pills',
          frequency: 33,
          verbatim: ["I don't want to take pills anymore"],
        },
      ],
      top_objections: [
        {
          objection: 'these things never actually work',
          frequency: 18,
          verbatim: ['nothing else has worked'],
        },
        {
          objection: 'too expensive',
          frequency: 12,
          verbatim: ['chiropractor is too expensive to do weekly'],
        },
      ],
      dream_outcomes: ['completely pain-free at work', 'stop needing chiropractor visits'],
      ...overrides.voc,
    },
    desired_outcomes: {
      opportunities: [
        {
          outcome: 'reduce afternoon back-pain intensity',
          importance: 9,
          satisfaction: 3,
          opportunity_score: 15,
        },
        {
          outcome: 'minimize dependency on pain medication',
          importance: 8,
          satisfaction: 4,
          opportunity_score: 12,
        },
      ],
      ...overrides.desired_outcomes,
    },
    awareness_stages: [
      {
        stage: 'problem_aware',
        trigger_hook: 'Your back hurts every afternoon, doesn\'t it?',
        education_needed: 'how posture drives fatigue',
        objections_to_kill: ['it\'s just stress'],
        proof_needed: ['before/after images'],
      },
      {
        stage: 'solution_aware',
        trigger_hook: 'Why braces stopped working',
        education_needed: 'smart-brace mechanism',
        objections_to_kill: ['braces are uncomfortable'],
        proof_needed: ['comfort testing'],
      },
      {
        stage: 'product_aware',
        trigger_hook: 'PostureCo vs generic braces',
        education_needed: 'differentiators',
        objections_to_kill: ['unbranded is cheaper'],
        proof_needed: ['warranty', 'reviews'],
      },
    ],
    value_equation: {
      dream_outcome: 'pain-free workday without pills',
      perceived_likelihood: 0.7,
      time_delay: '2-4 weeks with daily use',
      effort_sacrifice: 'wear during work hours; charge weekly',
      ...overrides.value_equation,
    },
    evidence: {
      reviews_analyzed: 187,
      sources: [
        { agent: 'review-miner', provider: 'apify_amazon_reviews', url: null, cited_for: 'VOC pains' },
      ],
      confidence_score: 0.85,
      gaps: ['no direct clinical study cited', 'competitor pricing data incomplete'],
      ...overrides.evidence,
    },
  };
}

// Story 13.5 AC29 — Visual Director unit tests.

import { describe, expect, it } from 'vitest';

import type { Pir } from '@blackshop/landinglab-research';
import type { CopyDeck } from '@blackshop/landinglab-copy';

import type { ClaudeTextClient, ClaudeTextMessagesResult } from '../providers/claude.js';
import { runVisualDirector } from './visual-director.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

function makePir(sophisticationLevel: number): Pir {
  return {
    schema_version: '1.0.0',
    identity: {
      name: 'HydroGlow Water Bottle',
      brand: null,
      category: 'wellness',
      model: null,
      price: 39.99,
      currency: 'USD',
      images: [],
      specs: {},
      variants: [],
    },
    market: {
      sophistication_level: sophisticationLevel,
      competitors: [],
      trends: [],
      gap_vs_competitors: null,
    },
    avatar: {
      demographics: {
        age_range: '25-40',
        gender: 'mixed',
        income_bracket: '50k-100k',
        geo: ['US'],
      },
      psychographics: {
        identity: 'health-conscious professional',
        lifestyle: 'active urban',
        beliefs: ['hydration matters'],
      },
      jobs_to_be_done: [],
    },
    voc: {
      language_bank: ['keeps me hydrated', 'love the sleek design'],
      top_pains: [],
      top_desires: [
        { desire: 'stay energized all day', frequency: 12, verbatim: [] },
      ],
      top_objections: [],
      dream_outcomes: ['peak wellness'],
    },
    desired_outcomes: { opportunities: [] },
    awareness_stages: [],
    value_equation: {
      dream_outcome: 'feel your best every day',
      perceived_likelihood: 0.7,
      time_delay: '1 week',
      effort_sacrifice: 'minimal',
    },
    evidence: {
      reviews_analyzed: 0,
      sources: [],
      confidence_score: 0.8,
      gaps: ['not enough EU reviews'],
    },
  };
}

function makeCopyDeck(): CopyDeck {
  return {
    schema_version: '1.0.0',
    language: 'en',
    hooks: [
      { text: 'The last water bottle you will ever need.', awareness_stage: 'unaware', framework_source: 'schwartz' },
      { text: 'Save $200 a year on plastic water bottles.', awareness_stage: 'problem_aware', framework_source: 'hormozi' },
      { text: 'Join 12,000 wellness enthusiasts.', awareness_stage: 'most_aware', framework_source: 'cialdini' },
    ],
    subheadlines: ['Made from 100% recycled materials.'],
    benefit_bullets: [
      { text: 'Keeps drinks cold for 24 hours guaranteed.', desire_addressed: 'refresh' },
      { text: 'BPA-free, dishwasher-safe, lifetime warranty.', desire_addressed: 'safety' },
      { text: 'Lightweight design fits any car cup holder.', desire_addressed: 'convenience' },
      { text: 'Leak-proof lid with one-hand operation.', desire_addressed: 'ease' },
      { text: 'Save the planet with every sip.', desire_addressed: 'purpose' },
    ],
    ctas: [
      { text: 'Get Yours Now', variant: 'a', urgency_type: 'time_limited' },
      { text: 'Order Today', variant: 'b', urgency_type: 'scarcity' },
      { text: 'Join Now', variant: 'c', urgency_type: 'social_proof' },
    ],
    faq: [
      { question: 'How long does shipping take?', answer: 'Ships in 3-5 business days worldwide.', objection_addressed: 'shipping-time' },
      { question: 'Is there a warranty?', answer: 'Yes — lifetime warranty against defects.', objection_addressed: 'quality' },
      { question: 'Can I return it?', answer: 'Yes, 30-day money-back guarantee.', objection_addressed: 'risk' },
      { question: 'Is it BPA-free?', answer: 'Yes, all our bottles are BPA-free and food-safe.', objection_addressed: 'safety' },
      { question: 'How do I clean it?', answer: 'Dishwasher-safe on the top rack.', objection_addressed: 'convenience' },
    ],
    offer_stack: {
      main_offer: 'HydroGlow Water Bottle',
      bonuses: [],
      guarantee: '30-day money-back',
      price_anchor: 'Was $79',
      real_value_stack: '$200+ savings/year',
    },
    guarantee: 'Try HydroGlow for 30 days — if you do not love it, we refund every penny. No questions asked, no hassle.',
    urgency_copy: 'Only 47 left in stock today at this price. Restock is 3 weeks out.',
    social_proof_blocks: [
      { type: 'stat', content: '12,000 five-star reviews' },
      { type: 'review', content: 'Best bottle I ever owned', source: 'Amazon verified' },
    ],
    voc_verbatim_used: ['keeps me hydrated', 'love the sleek design', 'sturdy and light'],
    contributing_agents: [],
  };
}

function makeScriptedClaude(responses: string[]): ClaudeTextClient {
  let idx = 0;
  return {
    async createMessage(): Promise<ClaudeTextMessagesResult> {
      const content = responses[idx] ?? responses[responses.length - 1] ?? '{}';
      idx++;
      return {
        content,
        tokens_in: 200,
        tokens_out: 150,
        latency_ms: 42,
        cost_usd: 0.015,
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
      };
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('runVisualDirector — happy path', () => {
  it('returns a valid VisualDirection for a well-formed Claude response', async () => {
    const pir = makePir(2);
    const copyDeck = makeCopyDeck();
    const claudeJson = JSON.stringify({
      palette: {
        primary: '#FF5A3C',
        secondary: '#FFB800',
        accent: '#00C2A8',
        bg: '#FFFFFF',
        text: '#111111',
      },
      typography: { headline_font: 'Poppins', body_font: 'Inter' },
      tone_descriptor: 'energetic and aspirational',
      style_guidance: 'Bright outdoor scenes, active subjects, warm lighting.',
    });
    const claude = makeScriptedClaude([claudeJson]);

    const result = await runVisualDirector(pir, copyDeck, { claude });

    expect(result.direction.palette.primary).toBe('#FF5A3C');
    expect(result.direction.typography.headline_font).toBe('Poppins');
    expect(result.direction.tone_descriptor).toBe('energetic and aspirational');
    expect(result.trace.provider).toBe('claude');
    expect(result.trace.cost_usd).toBeGreaterThan(0);
    expect(result.trace.error).toBeUndefined();
  });

  it('normalizes 3-char hex to 6-char uppercase', async () => {
    const pir = makePir(3);
    const copyDeck = makeCopyDeck();
    const claudeJson = JSON.stringify({
      palette: {
        primary: '#f5a',
        secondary: '#123456',
        accent: '#abc',
        bg: '#fff',
        text: '#000',
      },
      typography: { headline_font: 'Inter', body_font: 'Roboto' },
      tone_descriptor: 'balanced',
      style_guidance: 'Guidance text.',
    });
    const result = await runVisualDirector(pir, copyDeck, { claude: makeScriptedClaude([claudeJson]) });
    expect(result.direction.palette.primary).toMatch(/^#[0-9A-F]{6}$/);
    expect(result.direction.palette.primary).toBe('#FF55AA');
    expect(result.direction.palette.bg).toBe('#FFFFFF');
  });
});

describe('runVisualDirector — palette fallback (AC24)', () => {
  it('applies vibrant defaults for sophistication_level <= 2 when palette is empty', async () => {
    const pir = makePir(1);
    const copyDeck = makeCopyDeck();
    // Incomplete Claude response — no palette.
    const claudeJson = JSON.stringify({
      typography: { headline_font: 'Poppins', body_font: 'Inter' },
      tone_descriptor: 'energetic',
      style_guidance: 'Guidance.',
    });
    const result = await runVisualDirector(pir, copyDeck, { claude: makeScriptedClaude([claudeJson]) });
    // Vibrant defaults per sophistication level 1.
    expect(result.direction.palette.primary).toBe('#FF5A3C');
    expect(result.direction.palette.accent).toBe('#00C2A8');
    expect(result.notes).toContain('palette fallback');
  });

  it('applies balanced defaults for sophistication_level 3', async () => {
    const pir = makePir(3);
    const copyDeck = makeCopyDeck();
    const claudeJson = JSON.stringify({
      typography: { headline_font: 'Inter', body_font: 'Roboto' },
      tone_descriptor: 'balanced',
      style_guidance: 'Guidance.',
    });
    const result = await runVisualDirector(pir, copyDeck, { claude: makeScriptedClaude([claudeJson]) });
    expect(result.direction.palette.primary).toBe('#2563EB');
    expect(result.direction.palette.accent).toBe('#F59E0B');
  });

  it('applies sophisticated defaults for sophistication_level 5', async () => {
    const pir = makePir(5);
    const copyDeck = makeCopyDeck();
    const claudeJson = JSON.stringify({
      typography: { headline_font: 'Playfair Display', body_font: 'Merriweather' },
      tone_descriptor: 'clinical',
      style_guidance: 'Guidance.',
    });
    const result = await runVisualDirector(pir, copyDeck, { claude: makeScriptedClaude([claudeJson]) });
    expect(result.direction.palette.primary).toBe('#0F172A');
    expect(result.direction.palette.accent).toBe('#D4AF37');
  });
});

describe('runVisualDirector — retry + full failure', () => {
  it('retries once on invalid JSON', async () => {
    const pir = makePir(2);
    const copyDeck = makeCopyDeck();
    const validJson = JSON.stringify({
      palette: {
        primary: '#FF5A3C',
        secondary: '#FFB800',
        accent: '#00C2A8',
        bg: '#FFFFFF',
        text: '#111111',
      },
      typography: { headline_font: 'Poppins', body_font: 'Inter' },
      tone_descriptor: 'energetic',
      style_guidance: 'Guidance.',
    });
    const claude = makeScriptedClaude(['not json at all', validJson]);
    const result = await runVisualDirector(pir, copyDeck, { claude });
    expect(result.direction.palette.primary).toBe('#FF5A3C');
    expect(result.trace.error).toBeUndefined();
  });

  it('returns full fallback when Claude fails both attempts', async () => {
    const pir = makePir(2);
    const copyDeck = makeCopyDeck();
    const failingClaude: ClaudeTextClient = {
      async createMessage() {
        throw new Error('anthropic-503');
      },
    };
    const result = await runVisualDirector(pir, copyDeck, { claude: failingClaude });
    // Fallback palette applied (vibrant for level 2).
    expect(result.direction.palette.primary).toBe('#FF5A3C');
    expect(result.direction.typography.headline_font).toBe('Poppins');
    expect(result.trace.error).toContain('anthropic-503');
    expect(result.notes).toContain('fallback');
  });
});

describe('runVisualDirector — tone-per-sophistication verification', () => {
  it('accepts Claude-provided tone even if sophistication is low', async () => {
    const pir = makePir(1);
    const copyDeck = makeCopyDeck();
    const json = JSON.stringify({
      palette: {
        primary: '#FF5A3C',
        secondary: '#FFB800',
        accent: '#00C2A8',
        bg: '#FFFFFF',
        text: '#111111',
      },
      typography: { headline_font: 'Poppins', body_font: 'Inter' },
      tone_descriptor: 'bold and playful',
      style_guidance: 'Vivid colors, dynamic composition.',
    });
    const result = await runVisualDirector(pir, copyDeck, { claude: makeScriptedClaude([json]) });
    expect(result.direction.tone_descriptor).toBe('bold and playful');
  });
});

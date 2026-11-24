// Fixture for a fully valid CopyDeck (all schema constraints satisfied).
// Tests reuse and mutate this to trigger specific validation branches.

import type { CopyDeck } from '../schema/copy-deck.js';

export function makeValidCopyDeck(overrides: Partial<CopyDeck> = {}): CopyDeck {
  return {
    schema_version: '1.0.0',
    language: 'en',
    hooks: [
      {
        text: 'Stop suffering through afternoons hunched at your desk in silent pain',
        awareness_stage: 'problem_aware',
        framework_source: 'schwartz',
      },
      {
        text: 'The smart brace that trains your posture while you work — no reminders needed',
        awareness_stage: 'solution_aware',
        framework_source: 'schwartz',
      },
      {
        text: 'PostureCo Smart Brace — the 60-second setup that ends afternoon back pain',
        awareness_stage: 'product_aware',
        framework_source: 'schwartz',
      },
    ],
    subheadlines: [
      'Backed by biofeedback tech chiropractors use — now wearable and affordable.',
    ],
    benefit_bullets: [
      {
        text: 'Ease afternoon tension in the first week — micro-vibration cues realign posture',
        desire_addressed: 'reduce daily back pain without pills',
        voc_source: 'my back was killing me by 3pm every single day',
      },
      {
        text: 'Skip the $85 chiropractor visits — one-time cost, wearable at your desk',
        desire_addressed: 'save on chiropractor visits',
        voc_source: 'chiropractor is too expensive to do weekly',
      },
      {
        text: 'Stop reaching for pills — smart-brace addresses cause, not symptom',
        desire_addressed: 'avoid pain medication',
        voc_source: "I don't want to take pills anymore",
      },
      {
        text: 'Wear it under any shirt — no bulky visible bracing that draws stares',
        desire_addressed: 'discreet daily use',
        voc_source: null,
      },
      {
        text: 'Charge weekly, use daily — 7-day battery lasts a full work week',
        desire_addressed: 'low-maintenance solution',
        voc_source: null,
      },
    ],
    ctas: [
      { text: 'Get My Free Guide + Brace', variant: 'a', urgency_type: 'authority' },
      { text: 'Claim Before Friday', variant: 'b', urgency_type: 'time_limited' },
      { text: 'Join The Movement', variant: 'c', urgency_type: 'social_proof' },
    ],
    faq: [
      {
        question: 'These things never actually work — why is this different?',
        answer:
          'It sounds like you\'ve been burned by generic braces before. This one uses biofeedback (not just fabric) so it retrains posture instead of just holding you upright.',
        objection_addressed: 'these things never actually work',
        voss_technique: 'label',
      },
      {
        question: 'How long until I feel a difference?',
        answer:
          'Most users report reduced afternoon tension within the first week of daily use. Full posture retraining takes 2-4 weeks.',
        objection_addressed: 'skeptical of results',
        voss_technique: 'summary',
      },
      {
        question: 'Is $49 really enough for smart tech?',
        answer:
          'You\'re probably wondering if we\'re cutting corners. We\'re not — we saved on retail markup by selling direct. Same hardware chiropractors use in-office.',
        objection_addressed: 'too expensive or too cheap',
        voss_technique: 'accusation_audit',
      },
      {
        question: 'Can I wear it under work clothes?',
        answer:
          'Yes — it\'s low-profile enough to fit under a button-down or blouse. No visible external straps.',
        objection_addressed: 'visibility concerns',
        voss_technique: 'tactical_empathy',
      },
      {
        question: 'What happens if it doesn\'t work for me?',
        answer:
          'Full 60-day refund, no questions asked. You keep the digital coaching bonuses. What would need to be true for you to feel confident trying it?',
        objection_addressed: 'purchase risk',
        voss_technique: 'calibrated_question',
      },
    ],
    offer_stack: {
      main_offer: 'The PostureCo Smart Brace — biofeedback wearable + 30-day digital coaching',
      bonuses: [
        {
          name: 'Instant-Relief Stretch Library',
          perceived_value: 'Worth $47',
          description: '17 desk-friendly stretches videoed in 60s each',
        },
        {
          name: '30-Day Posture Reset Coaching',
          perceived_value: 'Worth $97',
          description: 'Daily 5-minute check-ins guiding retraining',
        },
      ],
      guarantee:
        '60-day no-questions-asked full refund. If you don\'t feel a difference in 30 days, we refund you and you keep every bonus.',
      price_anchor:
        'Chiropractor visits average $85 per session. This is a one-time cost — under two visits.',
      real_value_stack: 'Total value: $193 — today only: $49.',
    },
    guarantee:
      '60-day no-questions-asked full refund. If you don\'t feel a difference in 30 days, we refund you and you keep every bonus.',
    urgency_copy:
      'Free coaching-call bonus expires when this shipping batch closes (Friday). Only current-batch orders get it.',
    social_proof_blocks: [
      {
        type: 'stat',
        content: 'Analyzed across 187 verified reviews — 84% report meaningful pain reduction.',
        source: null,
      },
      {
        type: 'review',
        content:
          '"First thing that actually stopped my afternoon back tension." — verified buyer',
        source: 'verified buyer',
      },
    ],
    voc_verbatim_used: [
      'my back was killing me by 3pm every single day',
      "I don't want to take pills anymore",
      'chiropractor is too expensive to do weekly',
    ],
    contributing_agents: [
      { block: 'hooks', agent: 'schwartz', confidence: 0.9 },
      { block: 'offer_stack', agent: 'hormozi', confidence: 0.9 },
      { block: 'faq', agent: 'voss', confidence: 0.9 },
      { block: 'social_proof_blocks', agent: 'cialdini', confidence: 0.85 },
      { block: 'benefit_bullets', agent: 'halbert', confidence: 0.85 },
    ],
    ...overrides,
  };
}

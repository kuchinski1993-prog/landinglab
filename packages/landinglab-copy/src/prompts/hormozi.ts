// Hormozi system prompt — offer stack, urgency, benefit bullets.
//
// Blocos que este agent produz:
//   - offer_stack (main_offer + bonuses[] + guarantee + price_anchor + real_value_stack)
//   - urgency_copy (baseado em value_equation.time_delay)
//   - benefit_bullets (5-8, ODI-driven — prioriza opportunity_score >= 12)
//   - guarantee (string >= 50 chars, plausível)
//
// Referências:
//   - Alex Hormozi "$100M Offers" — Value Equation, Offer Stacks, Guarantees
//   - Story 13.4 AC10

import type { Pir } from '@blackshop/landinglab-research';

function summarizeOpportunities(pir: Pir): string {
  const top = pir.desired_outcomes.opportunities
    .filter((o) => o.opportunity_score >= 10)
    .sort((a, b) => b.opportunity_score - a.opportunity_score)
    .slice(0, 6);
  if (top.length === 0) {
    return '(no high-priority ODI opportunities returned by research — infer from top_pains + top_desires)';
  }
  return top.map((o) => `- "${o.outcome}" (score ${o.opportunity_score.toFixed(1)})`).join('\n');
}

function summarizeCompetitors(pir: Pir): string {
  if (pir.market.competitors.length === 0) return '(no competitor data available)';
  return pir.market.competitors
    .slice(0, 4)
    .map(
      (c) =>
        `- ${c.name}${c.price_range ? ` [${c.price_range}]` : ''}${c.weakness ? ` — weakness: ${c.weakness}` : ''}`,
    )
    .join('\n');
}

/**
 * Full Hormozi copywriter prompt. Called by runHormoziAgent.
 */
export function buildHormoziSystemPrompt(language: string, pir: Pir): string {
  const langUpper = language.toUpperCase();
  const priceStr =
    pir.identity.price != null
      ? `${pir.identity.currency ?? '$'}${pir.identity.price}`
      : '(price unknown — infer or leave placeholder)';

  return `You are the HORMOZI copywriter of a landing-page squad. You apply Alex Hormozi's "$100M Offers" framework — Value Equation, Offer Stacks, Grand Slam Guarantees.

TARGET LANGUAGE: ${langUpper}. Write NATIVELY in ${langUpper} — do not translate from English. Use ${langUpper}-market cultural references (currency, examples, tone).

═══════════════════════════════════════════════════════════
PIR CONTEXT (read carefully — every field matters)
═══════════════════════════════════════════════════════════

PRODUCT:
- Name: ${pir.identity.name}
- Brand: ${pir.identity.brand ?? '(unknown)'}
- Category: ${pir.identity.category ?? '(unknown)'}
- Observed price: ${priceStr}

VALUE EQUATION (Hormozi):
- Dream outcome: ${pir.value_equation.dream_outcome}
- Perceived likelihood: ${pir.value_equation.perceived_likelihood.toFixed(2)}
- Time delay: ${pir.value_equation.time_delay}
- Effort/sacrifice: ${pir.value_equation.effort_sacrifice}

TOP ODI OPPORTUNITIES (importance + gap; use these as bullet anchors):
${summarizeOpportunities(pir)}

AVATAR JOBS-TO-BE-DONE (solution-free):
${pir.avatar.jobs_to_be_done
  .slice(0, 5)
  .map((j) => `- "${j.job}" (importance ${j.importance}, satisfaction ${j.satisfaction})`)
  .join('\n')}

COMPETITORS (to differentiate + anchor price):
${summarizeCompetitors(pir)}

═══════════════════════════════════════════════════════════
YOUR CONTRIBUTIONS TO THE COPY DECK
═══════════════════════════════════════════════════════════

1. offer_stack: complete stack with:
   - main_offer: one-sentence "${pir.identity.name}" positioning tied to the dream outcome
   - bonuses[]: 3-5 bonuses, each with { name, perceived_value ("Worth $XX"), description }.
     Bonuses must reduce time_delay or effort_sacrifice from the Value Equation.
   - guarantee: risk reversal (>= 50 chars). Ex.: "60-day, no-questions-asked full refund + keep the bonuses".
   - price_anchor: string comparing our offer vs the "true cost" (competitor price OR DIY cost). Ex.: "Comparable premium ${pir.identity.category ?? 'product'} sells for $XX — you get it plus bonuses for less."
   - real_value_stack: single sentence summing "Total value: $X — today only: $Y".

2. urgency_copy (single string >= 30 chars): urgency/scarcity tied to time_delay. Do NOT invent fake stock counts. Prefer time-based ("this week only", "before shipping window closes") or bundle-based ("free bonuses expire when this batch sells").

3. benefit_bullets: 5-8 bullets. Format: "[Outcome] — [mechanism] — [implied timeframe]". Every bullet MUST map to an ODI opportunity above OR to a top_pain from PIR. Include desire_addressed field per bullet.
   - Pull voc_source from pir.voc.language_bank when a bullet reuses customer wording.

4. voc_verbatim_used: array with 3+ verbatim strings from pir.voc.language_bank that you actually integrated in your bullets/offer copy. If language_bank is empty, use [] and Copy Chief will fallback.

═══════════════════════════════════════════════════════════
OUTPUT FORMAT (STRICT JSON — no prose, no markdown)
═══════════════════════════════════════════════════════════

Return ONE JSON object matching exactly this shape:

{
  "offer_stack": {
    "main_offer": "...",
    "bonuses": [ { "name": "...", "perceived_value": "...", "description": "..." } ],
    "guarantee": "...",
    "price_anchor": "...",
    "real_value_stack": "..."
  },
  "urgency_copy": "...",
  "guarantee": "...",
  "benefit_bullets": [
    { "text": "...", "desire_addressed": "...", "voc_source": null | "..." }
  ],
  "voc_verbatim_used": [ "verbatim from language_bank", ... ]
}

═══════════════════════════════════════════════════════════
CRITICAL RULES (Article IV — No Invention)
═══════════════════════════════════════════════════════════

- Use pir.voc.language_bank verbatim whenever possible. Never invent customer language.
- Never fabricate stats you cannot back from PIR (e.g., no "10,000 happy customers" unless it appears in evidence).
- Prices/currencies must respect ${langUpper} market conventions.
- All bonuses must be plausibly deliverable digital assets (PDFs, guides, video access, community access) — no physical bonuses that a dropshipping operator can't fulfill.
- CTA copy is NOT your job (Cialdini owns it).
- Hooks/headlines are NOT your job (Schwartz/Halbert own them).

Return ONE JSON object. No prose. No code fences.`;
}

/** Few-shot example returned as a compact reference (not sent to model — internal QA doc). */
export const HORMOZI_QUALITY_EXAMPLE = {
  offer_stack: {
    main_offer: 'The 30-Day Posture Reset — a wearable smart brace + digital coaching program',
    bonuses: [
      {
        name: 'Instant-Relief Stretch Library',
        perceived_value: 'Worth $47',
        description: '17 desk-friendly stretches videoed in 60s each',
      },
    ],
    guarantee:
      '60-day, no-questions-asked full refund. If you don\'t feel a difference in 30 days, we refund you and you keep the bonuses.',
    price_anchor: 'Chiropractor visits average $85 per session. This is a one-time cost — under two visits.',
    real_value_stack: 'Total value: $291 — today only: $49.',
  },
  urgency_copy: 'Free coaching-call bonus expires when this shipping batch closes (Friday).',
  guarantee:
    '60-day, no-questions-asked full refund. If you don\'t feel a difference in 30 days, we refund you and you keep the bonuses.',
  benefit_bullets: [
    {
      text: 'Reduce upper-back tension in the first week — micro-tension release via smart-brace vibration cues.',
      desire_addressed: 'reduce daily back pain without pills',
      voc_source: 'my back was killing me by 3pm every single day',
    },
  ],
  voc_verbatim_used: [
    'my back was killing me by 3pm every single day',
    'I don\'t want to take pills anymore',
    'chiropractor is too expensive to do weekly',
  ],
};

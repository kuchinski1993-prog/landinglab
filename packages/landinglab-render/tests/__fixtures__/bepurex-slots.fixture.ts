// Shared fixture for BepurexSlots — consumed by SM-1.2 landing + SM-1.3 advertorial tests.
//
// Cobre TODOS os slots opcionais quando possível pra maximizar surface do snapshot.
// Testes de fallback derivam overrides deste base via `bepurexSlotsFixture({...})`.

import type { BepurexSlots, BodySection } from '../../src/templates/landinglab/types.js';

export function bepurexSlotsFixture(overrides: Partial<BepurexSlots> = {}): BepurexSlots {
  const body_sections: BodySection[] = [
    {
      kind: 'problem_agitation',
      heading: 'The problem with generic supplements',
      paragraphs: [
        'You have tried every "miracle" pill on the shelf and still feel exhausted.',
        'The fine print hides a simple truth: mass-produced formulas skip the doses that actually matter.',
      ],
    },
    {
      kind: 'solution_benefits',
      heading: 'Why Bepurex works differently',
      benefits: [
        { text: 'Clinical-grade dosing verified in third-party labs' },
        { text: 'Pharmacist-formulated: no fillers, no sugar' },
        { text: 'Delivered fresh — never sits in a warehouse' },
      ],
    },
    {
      kind: 'bullets',
      heading: 'Inside every bottle',
      items: [
        { text: 'Vitamin B12 (methylcobalamin) — 1000 mcg' },
        { text: 'Iron bisglycinate — 25 mg (gentle on the stomach)' },
        { text: 'Vitamin D3 — 2000 IU' },
      ],
    },
    {
      kind: 'testimonials',
      heading: 'Trusted by 12,000+ customers',
      items: [
        { content: 'I got my energy back within two weeks. No jitters, no crash.', source: 'Sofia R.' },
        { content: 'Finally a supplement that respects my digestion.', source: 'Marco B.' },
      ],
    },
    {
      kind: 'faq',
      heading: 'Frequently asked',
      items: [
        { question: 'When will I feel the difference?', answer: 'Most people report a noticeable lift within 10–14 days.' },
        { question: 'Is it safe with medications?', answer: 'Consult your GP if you take blood thinners or thyroid drugs.' },
      ],
    },
    {
      kind: 'urgency',
      heading: 'Limited launch batch',
      body: 'We only produce what our nutritionists can supervise. Batch 04 closes on Sunday.',
    },
    {
      kind: 'guarantee',
      heading: '60-day peace of mind',
      body: 'If you do not feel better within 60 days, ship the bottles back — full refund, no questions.',
    },
  ];

  const dynamic_extras: BodySection[] = [
    {
      kind: 'stats',
      heading: 'By the numbers',
      items: [
        { label: 'Customers', value: '12k+' },
        { label: 'Trustpilot', value: '4.8/5' },
        { label: 'Refund rate', value: '<2%' },
      ],
    },
  ];

  return {
    language: 'en-GB',
    brand: {
      name: 'Bepurex',
      tagline: 'Pharmacist-formulated wellness, delivered fresh.',
      logo_url: 'https://cdn.example.com/bepurex/logo.png',
      palette: {
        primary: '#0a5f3a',
        secondary: '#f4a300',
        accent: '#c8322f',
        bg: '#fdfaf3',
        text: '#111111',
      },
      typography: {
        headline_font: 'Playfair Display',
        body_font: 'Inter',
      },
    },
    hero: {
      headline: 'The supplement stack pharmacists take themselves',
      subhead:
        'A clean, clinical-grade formula shipped straight from the lab — no middlemen, no fillers.',
      image_url: 'https://cdn.example.com/bepurex/hero.jpg',
      image_srcset: {
        mobile: 'https://cdn.example.com/bepurex/hero-600.jpg',
        og: 'https://cdn.example.com/bepurex/hero-1200.jpg',
        desktop: 'https://cdn.example.com/bepurex/hero-1920.jpg',
      },
      cta_primary: { text: 'Order the launch batch', variant: 'a', urgency_type: 'scarcity' },
    },
    body_sections,
    dynamic_extras,
    offer_stack: {
      core: 'Bepurex Wellness Stack — 60 day supply',
      bonuses: [
        {
          name: 'Personal nutritionist chat (30 days)',
          perceived_value: 'EUR 89',
          description: 'One-to-one guidance from a certified nutritionist.',
        },
      ],
      total_value: 'EUR 189',
      actual_price: 'EUR 69,95',
      savings: 'EUR 119,05',
      guarantee: '60-day money-back guarantee.',
    },
    ctas: {
      primary: { text: 'Order the launch batch', variant: 'a', urgency_type: 'scarcity' },
      secondary: { text: 'Read the ingredient dossier', variant: 'b' },
    },
    trust_badges: [
      { url: 'https://cdn.example.com/badges/gmp.png', alt: 'GMP certified' },
      { url: 'https://cdn.example.com/badges/vegan.png', alt: 'Vegan formula' },
    ],
    social_proof: {
      testimonials_content: [],
      badges_urls: [],
      before_after_urls: [],
    },
    sticky_cta: {
      text: 'Order now — EUR 69,95',
      price_hint: 'Free shipping · 60-day refund',
    },
    doctors_endorsement: {
      heading: 'What pharmacists say',
      body: 'Bepurex uses the exact bioavailable forms I recommend to my own clients — methylcobalamin over cyanocobalamin, bisglycinate over sulfate. That is rare in this category.',
      author: 'Dr. Anna Ferrari',
      credentials: 'PharmD, MSc Clinical Nutrition — University of Milan',
    },
    bundle_slots: [
      {
        name: 'Starter · 1 bottle',
        description: '30-day supply',
        priceCents: 3495,
        compareAtPriceCents: 4495,
        quantityUnits: 60,
        highlight: null,
      },
      {
        name: 'Popular · 2 bottles',
        description: '60-day supply',
        priceCents: 6295,
        compareAtPriceCents: 8990,
        quantityUnits: 120,
        highlight: 'popular',
      },
      {
        name: 'Best value · 3 bottles',
        description: '90-day supply + free gift',
        priceCents: 8495,
        compareAtPriceCents: 13485,
        quantityUnits: 180,
        highlight: 'best',
      },
    ],
    ...overrides,
  };
}

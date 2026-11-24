import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DynamicBlocks } from './dynamic-blocks.js';
import type { TemplateSlots } from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// QA note (Task #45):
//
// A task original pediu "parse5 block extraction + type/html/assets/
// editableFields[]". Esse contrato NÃO existe — o que existe é o inverso:
// templates React que RENDERIZAM slots via `renderToString`, com âncoras
// `data-block-id="{kind}-{index}"` e `data-block-kind="{kind}"` (linhas
// 45-49 de dynamic-blocks.tsx).
//
// Testes abaixo cobrem essa superfície REAL: SSR de blocos, âncoras
// data-* que a Fase 4 (regenerate-inline) usa pra localizar blocos no
// HTML pós-build.
// ─────────────────────────────────────────────────────────────────────────

function baseSlots(overrides: Partial<TemplateSlots> = {}): TemplateSlots {
  return {
    language: 'pt-BR',
    brand: {
      name: 'TestBrand',
      tagline: 'be tested',
      logo_url: 'https://cdn.example.com/logo.png',
      palette: {
        primary: '#111',
        secondary: '#222',
        accent: '#333',
        bg: '#fff',
        text: '#000',
      },
      typography: {
        headline_font: 'Inter',
        body_font: 'Inter',
      },
    },
    hero: {
      headline: 'Big Hero Line',
      subhead: 'Supporting subhead copy',
      image_url: 'https://cdn.example.com/hero.jpg',
      cta_primary: { text: 'Get it now', variant: 'a', urgency_type: 'scarcity' },
    },
    body_sections: [],
    offer_stack: {
      core: 'Core offer',
      bonuses: [],
      total_value: 'EUR 100',
      actual_price: 'EUR 49',
      savings: 'EUR 51',
      guarantee: '30-day money back',
    },
    ctas: {
      primary: { text: 'Buy now', variant: 'a', urgency_type: 'time_limited' },
    },
    trust_badges: [],
    social_proof: {
      testimonials_content: [],
      badges_urls: [],
      before_after_urls: [],
    },
    ...overrides,
  };
}

function render(slots: TemplateSlots): string {
  return renderToString(React.createElement(DynamicBlocks, slots));
}

describe('DynamicBlocks template — SSR block anchors (Fase 3)', () => {
  it('renders the fixed structural anchors: BrandStyle + Hero + Offer + Final CTA', () => {
    const html = render(baseSlots());
    expect(html).toContain('--color-primary:#111'); // BrandStyle CSS vars
    expect(html).toContain('Big Hero Line'); // Hero headline
    expect(html).toContain('id="offer"'); // OfferBlock anchor
    expect(html).toContain('Your turn'); // Final CTA block
  });

  it('renders trust badges only when non-empty (empty list = no badge markup)', () => {
    // Note: `.ll-badges` selector is always present in BrandStyle CSS (line 26
    // of shared.tsx), so we assert against the actual rendered <img> / <div>
    // wrapper markup, not the class token.
    const empty = render(baseSlots({ trust_badges: [] }));
    expect(empty).not.toContain('class="ll-badges"');

    const filled = render(
      baseSlots({
        trust_badges: [
          { url: 'https://cdn.example.com/b1.png', alt: 'trust1' },
          { url: 'https://cdn.example.com/b2.png', alt: 'trust2' },
        ],
      }),
    );
    expect(filled).toContain('class="ll-badges"');
    expect(filled).toContain('alt="trust1"');
    expect(filled).toContain('alt="trust2"');
  });

  it('renders sticky CTA bar only when sticky_cta is present', () => {
    // Same reason as trust badges: `.ll-sticky-cta` selector lives in the
    // stylesheet always; the runtime markup is what we care about.
    const without = render(baseSlots());
    expect(without).not.toContain('class="ll-sticky-cta"');

    const withSticky = render(
      baseSlots({ sticky_cta: { text: 'Buy sticky', price_hint: 'EUR 49' } }),
    );
    expect(withSticky).toContain('class="ll-sticky-cta"');
    expect(withSticky).toContain('Buy sticky');
    expect(withSticky).toContain('EUR 49');
  });

  it('emits data-block-id="{kind}-{index}" and data-block-kind for every body section', () => {
    const slots = baseSlots({
      body_sections: [
        {
          kind: 'bullets',
          heading: 'Why us',
          items: [{ text: 'Fast' }, { text: 'Cheap' }],
        },
        {
          kind: 'testimonials',
          heading: 'Reviews',
          items: [{ content: 'Great!', source: 'Alice' }],
        },
        {
          kind: 'faq',
          heading: 'Q&A',
          items: [{ question: 'Q1?', answer: 'A1.' }],
        },
      ],
    });
    const html = render(slots);

    // Regenerate-inline (Phase 4) targets these anchors to swap block content.
    expect(html).toContain('data-block-id="bullets-0"');
    expect(html).toContain('data-block-kind="bullets"');
    expect(html).toContain('data-block-id="testimonials-1"');
    expect(html).toContain('data-block-kind="testimonials"');
    expect(html).toContain('data-block-id="faq-2"');
    expect(html).toContain('data-block-kind="faq"');

    // Content propagates correctly.
    expect(html).toContain('Why us');
    expect(html).toContain('Fast');
    expect(html).toContain('Great!');
    expect(html).toContain('Q1?');
  });

  it('renders body_sections in the exact order the composer supplied (no re-sort)', () => {
    const slots = baseSlots({
      body_sections: [
        { kind: 'urgency', heading: 'Urgency first', body: 'now' },
        { kind: 'guarantee', heading: 'Guarantee second', body: '30d' },
      ],
    });
    const html = render(slots);
    const urgencyIdx = html.indexOf('Urgency first');
    const guaranteeIdx = html.indexOf('Guarantee second');
    expect(urgencyIdx).toBeGreaterThan(-1);
    expect(guaranteeIdx).toBeGreaterThan(-1);
    expect(urgencyIdx).toBeLessThan(guaranteeIdx);
  });

  it('handles all discriminated BodySection kinds without throwing (contract completeness)', () => {
    const slots = baseSlots({
      body_sections: [
        { kind: 'bullets', heading: 'B', items: [{ text: 'x' }] },
        { kind: 'story', heading: 'S', paragraphs: ['once'] },
        {
          kind: 'comparison',
          heading: 'C',
          rows: [{ feature: 'f', ours: 'o', theirs: 't' }],
        },
        { kind: 'stats', heading: 'St', items: [{ label: 'l', value: 'v' }] },
        { kind: 'testimonials', heading: 'T', items: [{ content: 'c' }] },
        { kind: 'faq', heading: 'F', items: [{ question: 'q', answer: 'a' }] },
        { kind: 'guarantee', heading: 'G', body: 'g' },
        { kind: 'urgency', heading: 'U', body: 'u' },
        {
          kind: 'before_after',
          heading: 'BA',
          before: { image_url: 'https://x/b.jpg', label: 'before' },
          after: { image_url: 'https://x/a.jpg', label: 'after' },
        },
        { kind: 'problem_agitation', heading: 'PA', paragraphs: ['pain'] },
        {
          kind: 'solution_benefits',
          heading: 'SB',
          benefits: [{ text: 'benefit' }],
        },
        {
          kind: 'gallery',
          heading: 'Gal',
          image_urls: ['https://x/1.jpg'],
        },
      ],
    });

    const html = render(slots);
    // All 12 kinds should produce anchors.
    for (const kind of [
      'bullets',
      'story',
      'comparison',
      'stats',
      'testimonials',
      'faq',
      'guarantee',
      'urgency',
      'before_after',
      'problem_agitation',
      'solution_benefits',
      'gallery',
    ]) {
      expect(html).toContain(`data-block-kind="${kind}"`);
    }
  });

  it('escapes hero headline (React SSR safety — no XSS via slots)', () => {
    const slots = baseSlots({
      hero: {
        headline: '<script>alert(1)</script>Head',
        subhead: 'sub',
        image_url: 'https://cdn.example.com/x.jpg',
        cta_primary: { text: 'buy' },
      },
    });
    const html = render(slots);
    expect(html).not.toContain('<script>alert(1)</script>Head');
    expect(html).toContain('&lt;script&gt;');
  });

  it('gallery block returns null (renders empty) when image_urls is empty', () => {
    // GalleryBlock returns null on empty list — anchor <div> still exists but
    // its inner content is empty. This guards the "no images = no gallery
    // section" invariant from shared.tsx line 406.
    const slots = baseSlots({
      body_sections: [{ kind: 'gallery', heading: 'Gal', image_urls: [] }],
    });
    const html = render(slots);
    // anchor still present (loop always wraps)…
    expect(html).toContain('data-block-kind="gallery"');
    // …but no gallery grid rendered (component returns null on empty input).
    expect(html).not.toContain('class="ll-gallery"');
    expect(html).not.toContain('class="ll-gallery__item"');
  });

  it('gallery truncates to first 8 images (perf guard from shared.tsx line 412)', () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://cdn.example.com/g${i}.jpg`);
    const slots = baseSlots({
      body_sections: [{ kind: 'gallery', heading: 'Gal', image_urls: urls }],
    });
    const html = render(slots);
    // First 8 rendered
    for (let i = 0; i < 8; i++) {
      expect(html).toContain(`https://cdn.example.com/g${i}.jpg`);
    }
    // 9th+ NOT rendered
    for (let i = 8; i < 12; i++) {
      expect(html).not.toContain(`https://cdn.example.com/g${i}.jpg`);
    }
  });

  it('renders empty state gracefully (no body_sections, no trust_badges, no sticky)', () => {
    // Edge case: minimum viable slots. Should still produce a valid HTML with
    // Hero + Offer + Final CTA anchors intact.
    const html = render(baseSlots());
    expect(html).toContain('Big Hero Line');
    expect(html).toContain('id="offer"');
    expect(html).toContain('Your turn');
  });
});

describe('DynamicBlocks — CtaButton wiring', () => {
  it('primary CTA in Hero links to #offer anchor (SPA-style scroll)', () => {
    const html = render(baseSlots());
    // Both Hero CTA and Offer CTA use href="#offer" (see shared.tsx line 46).
    const matches = html.match(/href="#offer"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('renders data-cta-variant and data-urgency attrs for A/B tracking', () => {
    const html = render(
      baseSlots({
        ctas: {
          primary: { text: 'Buy', variant: 'b', urgency_type: 'authority' },
        },
      }),
    );
    expect(html).toContain('data-cta-variant="b"');
    expect(html).toContain('data-urgency="authority"');
  });
});

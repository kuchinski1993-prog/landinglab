// SM-1.3 — BepurexAdvertorialV1 SSR snapshot + contract tests.
//
// Cobre:
// - AC9 renderToString sem erros SSR
// - AC10 snapshot commitado (via `toMatchFileSnapshot` -> arquivo .snap externo)
// - AC7 ordem visual advertorial
// - AC8 fallbacks graciosos (slots ausentes)
// - AC11 WCAG-friendly attrs (proxy p/ axe-core — ver dev-notes na story)
//   axe-core não faz parte do workspace ainda; validamos alt/lang/aria/role
//   estruturais + separação sem "orphan text" clicável.
// - FR-7 dynamic_extras renderizados como blocos com âncoras data-block-*

import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BepurexAdvertorialV1 } from '../src/templates/landinglab/bepurex-advertorial-v1.js';

import { bepurexSlotsFixture } from './__fixtures__/bepurex-slots.fixture.js';

function render(overrides = {}): string {
  return renderToString(React.createElement(BepurexAdvertorialV1, bepurexSlotsFixture(overrides)));
}

describe('BepurexAdvertorialV1 — SSR + slot contract', () => {
  it('produces valid SSR output with fixture (AC9)', () => {
    const html = render();
    expect(html).toContain('data-skeleton-id="bepurex-advertorial-v1"');
    expect(html).toContain('lang="en-GB"');
    // React.renderToString não lança em componentes válidos; garantimos que
    // o output tem tamanho não trivial (>2KB) — smoke test de completude.
    expect(html.length).toBeGreaterThan(2000);
  });

  it('matches committed HTML snapshot (AC10)', async () => {
    const html = render();
    await expect(html).toMatchFileSnapshot('./__snapshots__/bepurex-advertorial-v1.snap');
  });

  it('renders in advertorial narrative order: problem → solution → bullets → testimonials → doctors → bundles → guarantee → faq → urgency → footer (AC7)', () => {
    const html = render();
    const order = [
      'The problem with generic supplements', // problem_agitation
      'Why Bepurex works differently', // solution_benefits
      'Inside every bottle', // bullets
      'Trusted by 12,000+ customers', // testimonials
      'What pharmacists say', // doctors_endorsement
      'Choose your pack', // bundle_slots section heading
      '60-day peace of mind', // guarantee
      'Frequently asked', // faq
      'Limited launch batch', // urgency
    ];
    const indices = order.map((needle) => html.indexOf(needle));
    for (let i = 0; i < indices.length; i++) {
      expect(indices[i], `Expected "${order[i]}" to appear in HTML`).toBeGreaterThan(-1);
      if (i > 0) {
        expect(
          indices[i],
          `Expected "${order[i]}" (idx ${indices[i]}) to appear AFTER "${order[i - 1]}" (idx ${indices[i - 1]})`,
        ).toBeGreaterThan(indices[i - 1]);
      }
    }
  });

  it('injects CSS variables from brand palette + typography (AC4)', () => {
    const html = render();
    expect(html).toContain('--color-primary:#0a5f3a');
    expect(html).toContain('--color-secondary:#f4a300');
    expect(html).toContain('--color-accent:#c8322f');
    expect(html).toContain('--color-bg:#fdfaf3');
    expect(html).toContain("--font-headline:'Playfair Display'");
    expect(html).toContain("--font-body:'Inter'");
  });

  it('injects fixed design tokens exactly once (AC5)', () => {
    const html = render();
    // Fixed token defined at top of the template.
    const matches = html.match(/--ll-radius: 12px/g) ?? [];
    expect(matches.length).toBe(1);
    expect(html).toContain('--ll-shadow');
    expect(html).toContain('--ll-space-md');
  });

  it('renders sticky CTA when sticky_cta present (AC7 footer contract)', () => {
    const html = render();
    expect(html).toContain('class="ll-sticky-cta"');
    expect(html).toContain('Order now — EUR 69,95');
    expect(html).toContain('Free shipping · 60-day refund');
  });

  it('renders bundle_slots as cards with pricing + highlight badges', () => {
    const html = render();
    expect(html).toContain('Starter · 1 bottle');
    expect(html).toContain('Popular · 2 bottles');
    expect(html).toContain('Best value · 3 bottles');
    // Price formatter EUR — 34.95 / 62.95 / 84.95.
    expect(html).toContain('EUR 34.95');
    expect(html).toContain('EUR 62.95');
    expect(html).toContain('EUR 84.95');
    // Highlights render badges.
    expect(html).toContain('Popular');
    expect(html).toContain('Best value');
  });

  it('renders dynamic_extras with data-block-* anchors (FR-7)', () => {
    const html = render();
    // Fixture has 1 dynamic_extra: kind='stats' -> data-block-id="dynamic-stats-0"
    expect(html).toContain('data-block-kind="stats"');
    expect(html).toContain('data-block-id="dynamic-stats-0"');
    expect(html).toContain('By the numbers');
  });
});

describe('BepurexAdvertorialV1 — graceful fallbacks (AC8)', () => {
  it('omits problem_agitation section when missing without crashing', () => {
    const html = render({
      body_sections: [
        {
          kind: 'bullets',
          heading: 'Bullets only',
          items: [{ text: 'x' }],
        },
      ],
    });
    expect(html).not.toContain('The problem with generic supplements');
    expect(html).toContain('Bullets only');
  });

  it('falls back to default guarantee when body_sections lacks one', () => {
    const html = render({
      body_sections: [
        {
          kind: 'bullets',
          heading: 'x',
          items: [{ text: 'y' }],
        },
      ],
      offer_stack: {
        core: 'Core',
        bonuses: [],
        total_value: 'EUR 100',
        actual_price: 'EUR 49',
        savings: 'EUR 51',
        guarantee: '',
      },
    });
    expect(html).toContain('Risk-free promise');
    expect(html).toContain('30-day money-back guarantee');
  });

  it('uses offer_stack.guarantee as fallback body when present', () => {
    const html = render({
      body_sections: [{ kind: 'bullets', heading: 'x', items: [{ text: 'y' }] }],
      offer_stack: {
        core: 'Core',
        bonuses: [],
        total_value: 'EUR 100',
        actual_price: 'EUR 49',
        savings: 'EUR 51',
        guarantee: 'Custom 90-day guarantee.',
      },
    });
    expect(html).toContain('Risk-free promise');
    expect(html).toContain('Custom 90-day guarantee.');
  });

  it('omits bundle_slots section when list is empty', () => {
    const html = render({ bundle_slots: [] });
    expect(html).not.toContain('Choose your pack');
  });

  it('omits doctors_endorsement when slot absent', () => {
    const html = render({ doctors_endorsement: undefined });
    expect(html).not.toContain('What pharmacists say');
  });

  it('omits sticky CTA when slot absent', () => {
    const html = render({ sticky_cta: undefined });
    expect(html).not.toContain('class="ll-sticky-cta"');
  });

  it('omits trust badges when empty', () => {
    const html = render({ trust_badges: [] });
    // ll-badges class only rendered by TrustBadges when non-empty
    expect(html).not.toContain('class="ll-badges"');
  });

  it('handles empty dynamic_extras without inserting anchors', () => {
    const html = render({ dynamic_extras: [] });
    expect(html).not.toContain('data-block-id="dynamic-');
  });

  it('renders 3 dynamic_extras with unique anchors (FR-7 max 0-3)', () => {
    const html = render({
      dynamic_extras: [
        { kind: 'gallery', heading: 'G', image_urls: ['https://cdn.example.com/x.jpg'] },
        { kind: 'story', heading: 'S', paragraphs: ['once'] },
        { kind: 'comparison', heading: 'C', rows: [{ feature: 'f', ours: 'o', theirs: 't' }] },
      ],
    });
    expect(html).toContain('data-block-id="dynamic-gallery-0"');
    expect(html).toContain('data-block-id="dynamic-story-1"');
    expect(html).toContain('data-block-id="dynamic-comparison-2"');
  });
});

describe('BepurexAdvertorialV1 — WCAG-friendly structural attrs (AC11 proxy)', () => {
  it('sets lang attribute on wrapper', () => {
    const html = render({ language: 'it-IT' });
    expect(html).toContain('lang="it-IT"');
  });

  it('all <img> elements carry alt text (never empty for content imgs)', () => {
    const html = render();
    // Extract every <img ...> tag
    const imgTags = html.match(/<img[^>]*>/g) ?? [];
    expect(imgTags.length).toBeGreaterThan(0);
    for (const tag of imgTags) {
      expect(tag, `img without alt attr: ${tag}`).toMatch(/alt="/);
    }
  });

  it('uses semantic landmarks: header, main, footer', () => {
    const html = render();
    expect(html).toContain('<header');
    expect(html).toContain('<main>');
    expect(html).toContain('<footer');
    expect(html).toContain('role="banner"');
    expect(html).toContain('role="contentinfo"');
  });

  it('bundle cards use <article> + aria-labelledby for programmatic labels', () => {
    const html = render();
    expect(html).toContain('aria-labelledby="ll-adv-bundle-h-0"');
    expect(html).toContain('id="ll-adv-bundle-h-0"');
  });

  it('CTAs are focusable anchors (not raw text) and describe target', () => {
    const html = render();
    // Bundle cards use aria-label to disambiguate the primary CTA per card.
    expect(html).toContain('aria-label="Order the launch batch — Starter · 1 bottle"');
  });

  it('lucide icons are aria-hidden (decorative)', () => {
    const html = render();
    // Every lucide-react svg we ship in this template is decorative.
    const svgs = html.match(/<svg[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg, `svg without aria-hidden: ${svg}`).toMatch(/aria-hidden/);
    }
  });

  it('escapes headline text (XSS via slots)', () => {
    const html = render({
      hero: {
        headline: '<script>alert(1)</script>Head',
        subhead: 'sub',
        image_url: 'https://cdn.example.com/x.jpg',
        cta_primary: { text: 'buy' },
      },
    });
    expect(html).not.toContain('<script>alert(1)</script>Head');
    expect(html).toContain('&lt;script&gt;');
  });
});

// SM-1.2 — BepurexLandingV1 SSR snapshot + contract tests.
//
// Cobre:
// - AC2/AC8: renderToString sem erros SSR
// - AC3: ícones Lucide (SVG inline) — zero FontAwesome/emoji
// - AC4: CSS variables --color-*/--font-* injetadas via BrandStyle
// - AC5: design tokens fixos (--ll-radius, --ll-shadow, --ll-space-*) — 1×
// - AC6: reusa blocks compartilhados (BulletsBlock, FaqBlock, etc)
// - AC7: fallbacks graciosos (slots ausentes)
// - AC9: snapshot commitado (via `toMatchFileSnapshot`)
// - AC10 (proxy WCAG): alt em imgs, semantic landmarks, aria-hidden em SVG
// - AC11 (responsividade): media queries no CSS inline
// - FR-7: dynamic_extras (0-3 allowed) com âncoras data-block-*

import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BepurexLandingV1 } from '../src/templates/landinglab/bepurex-landing-v1.js';

import { bepurexSlotsFixture } from './__fixtures__/bepurex-slots.fixture.js';

function render(overrides = {}): string {
  return renderToString(
    React.createElement(BepurexLandingV1, bepurexSlotsFixture(overrides)),
  );
}

describe('BepurexLandingV1 — SSR + slot contract (SM-1.2)', () => {
  it('AC2/AC8: renderiza sem erros usando BepurexSlots do fixture', () => {
    const html = render();
    expect(html).toContain('data-skeleton-id="bepurex-landing-v1"');
    expect(html).toContain('lang="en-GB"');
    expect(html.length).toBeGreaterThan(2000);
  });

  it('AC9: bate com snapshot commitado (regressão estrutural)', async () => {
    const html = render();
    await expect(html).toMatchFileSnapshot('./__snapshots__/bepurex-landing-v1.snap');
  });

  it('AC4: injeta CSS variables --color-* + --font-* do brand palette', () => {
    const html = render();
    expect(html).toContain('--color-primary:#0a5f3a');
    expect(html).toContain('--color-secondary:#f4a300');
    expect(html).toContain('--color-accent:#c8322f');
    expect(html).toContain('--color-bg:#fdfaf3');
    expect(html).toContain("--font-headline:'Playfair Display'");
    expect(html).toContain("--font-body:'Inter'");
  });

  it('AC5: design tokens fixos injetados exatamente 1× (--ll-radius, --ll-shadow, --ll-space-*)', () => {
    const html = render();
    const radiusMatches = html.match(/--ll-radius: 12px/g) ?? [];
    expect(radiusMatches.length).toBe(1);
    expect(html).toContain('--ll-shadow');
    expect(html).toContain('--ll-space-md');
    expect(html).toContain('--ll-space-lg');
    expect(html).toContain('--ll-fs-lg');
  });

  it('AC3: ícones exclusivamente Lucide (lucide-* class + SVG viewBox 24) — zero FontAwesome', () => {
    const html = render();
    expect(html).toMatch(/<svg[^>]*viewBox="0 0 24 24"/);
    expect(html).toMatch(/class="lucide/);
    // Zero <i class="fa-*"> / "fas " / "far " (FontAwesome banido).
    expect(html).not.toMatch(/class="[^"]*fa-[a-z]/);
    expect(html).not.toMatch(/class="[^"]*fas /);
  });

  it('AC6: reusa blocks compartilhados (BulletsBlock, TestimonialsBlock, FaqBlock, ComparisonBlock, GuaranteeWrapper)', () => {
    const html = render();
    expect(html).toContain('class="ll-bullets"'); // BulletsBlock
    expect(html).toContain('class="ll-testimonial"'); // TestimonialsBlock
    expect(html).toContain('ll-faq'); // FaqBlock section wrapper (ll-section ll-faq)
    expect(html).toContain('class="ll-guarantee"'); // Guarantee wrapper
  });

  it('renderiza todos os 12 slots fixos com data-slot markers', () => {
    const html = render({
      // remove comparison (é optional; presença é via body_sections)
    });
    const expectedSlots = [
      'header',
      'hero',
      'benefits',
      'how_it_works', // via TimelineBlock — não usa data-slot atributo, cheque class abaixo
      'reviews',
      'trust_badges',
      'guarantee',
      'faq',
      'cta_footer',
      'legal',
      'tracking',
    ];
    for (const slot of expectedSlots) {
      if (slot === 'how_it_works') continue; // testado via class abaixo
      expect(html).toContain(`data-slot="${slot}"`);
    }
    // how_it_works timeline
    expect(html).toContain('class="ll-lpv1-timeline"');
    expect(html).toContain('data-slot="how_it_works"');
  });

  it('renderiza bundle_slots como <article> com aria-labelledby + highlight visual', () => {
    const html = render();
    // 3 bundles no fixture: Starter, Popular, Best value
    expect(html).toContain('data-bundle-highlight="popular"');
    expect(html).toContain('data-bundle-highlight="best"');
    expect(html).toContain('Most popular');
    expect(html).toContain('Best value');
    // Semântica WCAG
    expect(html).toContain('aria-labelledby="ll-lpv1-bundle-h-0"');
    expect(html).toContain('id="ll-lpv1-bundle-h-0"');
    // Preços formatados: 34.95 / 62.95 / 84.95
    expect(html).toContain('34.95');
    expect(html).toContain('62.95');
    expect(html).toContain('84.95');
    // CTA aria-label por card
    expect(html).toContain('aria-label="Order the launch batch — Starter · 1 bottle"');
  });

  it('renderiza doctors_endorsement quando presente', () => {
    const html = render();
    expect(html).toContain('data-slot="doctors_endorsement"');
    expect(html).toContain('Dr. Anna Ferrari');
  });

  it('renderiza ingredients quando body_sections tem 2 bullets, o 2º com heading /ingredient/i', () => {
    const html = render({
      body_sections: [
        {
          kind: 'bullets',
          heading: 'Why Bepurex',
          items: [{ text: 'Fast' }],
        },
        {
          kind: 'bullets',
          heading: 'Key ingredients',
          items: [{ text: 'Marine collagen 10g' }],
        },
      ],
    });
    expect(html).toContain('data-slot="ingredients"');
    expect(html).toContain('Key ingredients');
    expect(html).toContain('Marine collagen 10g');
    // O 1º bullets (benefits) também deve renderizar
    expect(html).toContain('Why Bepurex');
  });

  it('FR-7: renderiza dynamic_extras com âncoras data-block-{kind}-{i}', () => {
    // Fixture default tem 1 dynamic_extra (kind='stats').
    const html = render();
    expect(html).toContain('data-slot="dynamic_extras"');
    expect(html).toContain('data-block-kind="stats"');
    expect(html).toContain('data-block-id="dynamic-stats-0"');
    expect(html).toContain('By the numbers');
  });

  it('FR-7: dynamic_extras filtra kinds fora de allowed_types (só stats/gallery/before_after/guarantee)', () => {
    const html = render({
      dynamic_extras: [
        { kind: 'stats', heading: 'Certifications', items: [{ label: 'ISO', value: 'yes' }] },
        {
          kind: 'gallery',
          heading: 'Press',
          image_urls: ['https://cdn.example.com/logo.png'],
        },
        {
          kind: 'before_after',
          heading: 'Transform',
          before: { image_url: 'https://x/b.jpg', label: 'before' },
          after: { image_url: 'https://x/a.jpg', label: 'after' },
        },
        // Este não é allowed — deve ser filtrado.
        { kind: 'story', heading: 'NOT ALLOWED', paragraphs: ['nope'] },
      ],
    });
    expect(html).toContain('data-block-id="dynamic-stats-0"');
    expect(html).toContain('data-block-id="dynamic-gallery-1"');
    expect(html).toContain('data-block-id="dynamic-before_after-2"');
    expect(html).not.toContain('NOT ALLOWED');
    expect(html).not.toContain('data-block-id="dynamic-story-3"');
  });

  it('FR-7: dynamic_extras trunca no máximo 3 blocks', () => {
    const html = render({
      dynamic_extras: [
        { kind: 'stats', heading: 'S1', items: [{ label: 'a', value: 'b' }] },
        { kind: 'gallery', heading: 'G1', image_urls: ['https://x/1.jpg'] },
        {
          kind: 'before_after',
          heading: 'BA1',
          before: { image_url: 'https://x/b.jpg', label: 'x' },
          after: { image_url: 'https://x/a.jpg', label: 'y' },
        },
        // Este é o 4º — deve ser truncado.
        { kind: 'guarantee', heading: 'G_EXTRA_TRUNCATED', body: 'nope' },
      ],
    });
    expect(html).toContain('data-block-id="dynamic-stats-0"');
    expect(html).toContain('data-block-id="dynamic-gallery-1"');
    expect(html).toContain('data-block-id="dynamic-before_after-2"');
    expect(html).not.toContain('G_EXTRA_TRUNCATED');
  });

  it('AC11: CSS inclui media queries pra responsividade mobile/desktop (min-width 768)', () => {
    const html = render();
    expect(html).toContain('@media (min-width:768px)');
  });

  it('renderiza sticky_cta quando presente', () => {
    const html = render();
    expect(html).toContain('class="ll-sticky-cta"');
    expect(html).toContain('Order now — EUR 69,95');
  });

  it('AC10 proxy: todas <img> têm alt attribute', () => {
    const html = render();
    const imgTags = html.match(/<img[^>]*>/g) ?? [];
    expect(imgTags.length).toBeGreaterThan(0);
    for (const tag of imgTags) {
      expect(tag, `img sem alt: ${tag}`).toMatch(/alt="/);
    }
  });

  it('AC10 proxy: semantic landmarks (header/main/footer) presentes', () => {
    const html = render();
    expect(html).toContain('<header');
    expect(html).toContain('<main>');
    expect(html).toContain('<footer');
    expect(html).toContain('role="banner"');
    expect(html).toContain('role="contentinfo"');
  });

  it('AC10 proxy: todos os SVG lucide são aria-hidden (decorativos)', () => {
    const html = render();
    const svgs = html.match(/<svg[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg, `svg sem aria-hidden: ${svg}`).toMatch(/aria-hidden/);
    }
  });

  it('escapa headline (XSS via slots)', () => {
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

describe('BepurexLandingV1 — fallbacks graciosos (AC7)', () => {
  it('hero sem imagem → renderiza placeholder cinza', () => {
    const html = render({
      hero: {
        headline: 'H',
        subhead: 'S',
        image_url: '',
        cta_primary: { text: 'Buy' },
      },
    });
    expect(html).toContain('class="ll-lpv1-placeholder"');
    expect(html).toContain('Product image placeholder');
  });

  it('guarantee ausente no body_sections → usa offer_stack.guarantee', () => {
    const html = render({
      body_sections: [
        { kind: 'bullets', heading: 'Benefits', items: [{ text: 'x' }] },
      ],
      offer_stack: {
        core: 'Core',
        bonuses: [],
        total_value: 'EUR 100',
        actual_price: 'EUR 49',
        savings: 'EUR 51',
        guarantee: 'Custom 90-day guarantee body.',
      },
    });
    expect(html).toContain('30-day money-back guarantee'); // heading default
    expect(html).toContain('Custom 90-day guarantee body.');
  });

  it('guarantee ausente + offer_stack.guarantee vazio → texto default explícito', () => {
    const html = render({
      body_sections: [{ kind: 'bullets', heading: 'B', items: [{ text: 'x' }] }],
      offer_stack: {
        core: 'Core',
        bonuses: [],
        total_value: 'EUR 100',
        actual_price: 'EUR 49',
        savings: 'EUR 51',
        guarantee: '',
      },
    });
    expect(html).toContain('30-day money-back guarantee');
    expect(html).toContain('we refund every cent');
  });

  it('timeline ausente → 4 steps default (Week 1/2/6/10+)', () => {
    const html = render({ timeline: undefined });
    expect(html).toContain('How it works');
    expect(html).toContain('Week 1');
    expect(html).toContain('Week 10+');
  });

  it('faq ausente → default FAQ com 2 items', () => {
    const html = render({
      body_sections: [{ kind: 'bullets', heading: 'B', items: [{ text: 'x' }] }],
    });
    expect(html).toContain('Frequently asked questions');
    expect(html).toContain('When will I see results?');
  });

  it('benefits (bullets) ausentes → 3 defaults', () => {
    const html = render({ body_sections: [] });
    expect(html).toContain('Key benefits');
    expect(html).toContain('Clinically studied ingredients');
  });

  it('bundle_slots vazios → seção omitida', () => {
    const html = render({ bundle_slots: [] });
    expect(html).not.toContain('data-slot="bundles"');
    expect(html).not.toContain('class="ll-lpv1-bundles"');
  });

  it('doctors_endorsement ausente → omitido sem crash', () => {
    const html = render({ doctors_endorsement: undefined });
    expect(html).not.toContain('data-slot="doctors_endorsement"');
    expect(html).not.toContain('Dr. Anna Ferrari');
  });

  it('trust_badges vazios → wrapper renderiza sem markup interno', () => {
    const html = render({ trust_badges: [] });
    expect(html).not.toContain('class="ll-badges"');
  });

  it('dynamic_extras vazio → seção inteira omitida', () => {
    const html = render({ dynamic_extras: [] });
    expect(html).not.toContain('data-slot="dynamic_extras"');
    expect(html).not.toContain('data-block-id="dynamic-');
  });

  it('slots opcionais completamente vazios não crasham', () => {
    expect(() =>
      render({
        body_sections: [],
        dynamic_extras: [],
        bundle_slots: [],
        timeline: undefined,
        doctors_endorsement: undefined,
        sticky_cta: undefined,
        trust_badges: [],
      }),
    ).not.toThrow();
  });
});

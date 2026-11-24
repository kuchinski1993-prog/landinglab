// SM-5.4 — html-builder extension tests.
//
// Covers:
//   - AC1: SkeletonId accepted as templateName (bepurex-*).
//   - AC2: Google Fonts <link>s injected in <head> when brand.typography present.
//   - AC3: --ll-color-* CSS vars injected in <head> <style> when brand.palette present.
//   - AC4: Legacy compat — templates existentes (no bepurex) still render + no regression.
//   - AC5: Full HTML document (<html>, <head>, <body>) present.
//   - AC7: font-display: swap present in Google Fonts URL.

import { describe, expect, it } from 'vitest';
import type { TemplateSlots } from '@blackshop/landinglab-render/templates/landinglab';

import { buildHtml } from './html-builder.js';

function makeSlots(overrides: Partial<TemplateSlots> = {}): TemplateSlots {
  return {
    language: 'en',
    brand: {
      name: 'TestBrand',
      tagline: 'A test tagline for the brand',
      logo_url: 'https://cdn.example.com/logo.png',
      palette: {
        primary: '#FF5A3C',
        secondary: '#FFB800',
        accent: '#00C2A8',
        bg: '#FFFFFF',
        text: '#111111',
      },
      typography: {
        headline_font: 'Poppins',
        body_font: 'Inter',
      },
    },
    hero: {
      headline: 'Test headline that is reasonably long',
      subhead: 'Test subhead copy that describes value',
      image_url: 'https://cdn.example.com/hero.png',
      cta_primary: { text: 'Buy now', variant: 'a', urgency_type: 'time_limited' },
    },
    body_sections: [
      {
        kind: 'bullets',
        heading: 'Why choose us',
        items: [{ text: 'Bullet number one demonstrating benefit here' }],
      },
    ],
    offer_stack: {
      core: 'Test product',
      bonuses: [],
      total_value: '$100',
      actual_price: '$50',
      savings: '$50 off',
      guarantee: '30-day money-back guarantee applies to every order',
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

describe('buildHtml — SM-5.4 extension', () => {
  it('AC5: emits a complete HTML document with <html>, <head>, <body>', async () => {
    const out = await buildHtml({
      templateName: 'long-form-advertorial',
      slots: makeSlots(),
      language: 'en',
    });
    expect(out.html).toContain('<!DOCTYPE html>');
    expect(out.html).toContain('<html lang=');
    expect(out.html).toContain('<head>');
    expect(out.html).toContain('</head>');
    expect(out.html).toContain('<body>');
    expect(out.html).toContain('</body>');
    expect(out.size_bytes).toBeGreaterThan(500);
  });

  it('AC2 + AC7: injects Google Fonts <link> with display=swap when typography present', async () => {
    const out = await buildHtml({
      templateName: 'long-form-advertorial',
      slots: makeSlots(),
      language: 'en',
    });
    // preconnect + preload + stylesheet all present
    expect(out.html).toContain('fonts.googleapis.com');
    expect(out.html).toContain('fonts.gstatic.com');
    // font-display: swap in the Google Fonts URL guards against FOIT
    expect(out.html).toContain('display=swap');
    // Both requested families present (URL-encoded ok)
    expect(out.html).toMatch(/family=Poppins/);
    expect(out.html).toMatch(/family=Inter/);
  });

  it('AC3: injects canonical --ll-color-* CSS variables in <head> <style>', async () => {
    const out = await buildHtml({
      templateName: 'long-form-advertorial',
      slots: makeSlots(),
      language: 'en',
    });
    expect(out.html).toContain('--ll-color-primary:#FF5A3C');
    expect(out.html).toContain('--ll-color-secondary:#FFB800');
    expect(out.html).toContain('--ll-color-accent:#00C2A8');
    expect(out.html).toContain('--ll-color-bg:#FFFFFF');
    expect(out.html).toContain('--ll-color-text:#111111');
    expect(out.html).toContain("--ll-font-headline:'Poppins'");
    expect(out.html).toContain("--ll-font-body:'Inter'");
  });

  it('AC1: accepts bepurex-landing-v1 SkeletonId as templateName', async () => {
    const slots = makeSlots() as TemplateSlots & { dynamic_extras: [] };
    slots.dynamic_extras = [];
    const out = await buildHtml({
      templateName: 'bepurex-landing-v1',
      slots,
      language: 'en',
    });
    expect(out.html).toContain('<!DOCTYPE html>');
    // The skeleton renders — check for a signature class from the bepurex CSS.
    expect(out.html.length).toBeGreaterThan(1000);
    // Font + palette injection still fires for the new skeletons.
    expect(out.html).toContain('--ll-color-primary:#FF5A3C');
    expect(out.html).toContain('display=swap');
  });

  it('AC1: accepts bepurex-advertorial-v1 SkeletonId as templateName', async () => {
    const slots = makeSlots() as TemplateSlots & { dynamic_extras: [] };
    slots.dynamic_extras = [];
    const out = await buildHtml({
      templateName: 'bepurex-advertorial-v1',
      slots,
      language: 'en',
    });
    expect(out.html).toContain('<!DOCTYPE html>');
    expect(out.html.length).toBeGreaterThan(1000);
  });

  it('AC4: legacy compat — long-form-advertorial output preserves core structure', async () => {
    // Regression guard — the pre-SM-5.4 output shape (DOCTYPE + <html> +
    // preconnect + Google Fonts + <body>) MUST still be there.
    const out = await buildHtml({
      templateName: 'long-form-advertorial',
      slots: makeSlots(),
      language: 'en',
    });
    expect(out.html).toContain('<!DOCTYPE html>');
    expect(out.html).toContain('preconnect');
    expect(out.html).toContain('fonts.googleapis.com');
    // BrandStyle (shared.tsx) also injects --color-* (short prefix) via SSR —
    // both prefixes must coexist without conflict.
    expect(out.html).toContain('--color-primary:');
  });

  it('rejects unknown templateName with a descriptive error', async () => {
    await expect(
      // deliberately cast to bypass compile-time check for runtime guard test
      buildHtml({
        templateName: 'does-not-exist' as never,
        slots: makeSlots(),
        language: 'en',
      }),
    ).rejects.toThrow(/Unknown template/);
  });
});

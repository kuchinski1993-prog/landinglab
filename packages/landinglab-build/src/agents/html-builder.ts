// HTML Builder — React SSR + minification.
//
// Story 13.6 AC12. Deterministic. Picks the right template component, renders it
// via react-dom/server::renderToString, wraps in a full HTML document with brand
// fonts + placeholder <head> (SEO tags injected later by seo-optimizer), then
// minifies via html-minifier-terser (CSS custom properties preserved).
//
// SM-5.4 extension: accepts SkeletonId (superset of TemplateName incl. bepurex-*
// skeletons); when `slots.brand` is present injects Google Fonts <link>s AND a
// canonical `--ll-color-*` CSS variables block in <head> (in addition to the
// per-template BrandStyle already produced by shared.tsx via SSR). Legacy calls
// without `slots.brand` skip both injections — zero regression.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { minify } from 'html-minifier-terser';
import { TEMPLATES } from '@blackshop/landinglab-render/templates/landinglab';
import type {
  BepurexSlots,
  SkeletonId,
  TemplateSlots,
} from '@blackshop/landinglab-render/templates/landinglab';

/**
 * SM-5.4: `BuildHtmlSlots` accepts either the legacy `TemplateSlots` shape
 * (long-form-advertorial, short-form-direct, story-driven, dynamic-blocks) or
 * the extended `BepurexSlots` shape (bepurex-* skeletons). The runtime tolerates
 * both — callers targeting bepurex templates MUST provide `dynamic_extras`
 * (empty array ok); callers targeting legacy templates can pass either.
 */
export type BuildHtmlSlots = TemplateSlots | BepurexSlots;

export interface BuildHtmlInput {
  templateName: SkeletonId;
  slots: BuildHtmlSlots;
  language: string;
}

export interface BuildHtmlOutput {
  html: string;
  size_bytes: number;
}

/**
 * Google Fonts URL builder. Uses weight ranges that cover headline (700) + body
 * (400+600). Wave 3 can extract weights from typography if we widen the type.
 * `display=swap` avoids FOIT — text renders in fallback while webfont loads.
 */
function buildGoogleFontsHref(headline: string, body: string): string {
  const enc = (s: string) => encodeURIComponent(s.trim());
  return `https://fonts.googleapis.com/css2?family=${enc(headline)}:wght@700&family=${enc(body)}:wght@400;600&display=swap`;
}

/**
 * SM-5.4 AC3: emit canonical `--ll-color-*` CSS variables in <head> so any
 * downstream style hook (email-safe fragments, partial hydration, external
 * overrides) can rely on them BEFORE React SSR runs. shared.tsx's BrandStyle
 * still injects the shorter `--color-*` used by the actual templates — this
 * block is additive, not a replacement.
 * `font-display: swap` reinforced via @font-face-agnostic guard (relies on
 * Google Fonts URL `&display=swap`; the redundant `font-display` here is a
 * belt-and-suspenders for any preloaded local font fallback).
 */
function buildIdentityStyleTag(brand: BuildHtmlSlots['brand']): string {
  const p = brand.palette;
  const t = brand.typography;
  const css =
    ':root{' +
    `--ll-color-primary:${p.primary};` +
    `--ll-color-secondary:${p.secondary};` +
    `--ll-color-accent:${p.accent};` +
    `--ll-color-bg:${p.bg};` +
    `--ll-color-text:${p.text};` +
    `--ll-font-headline:'${t.headline_font}',sans-serif;` +
    `--ll-font-body:'${t.body_font}',sans-serif;` +
    '}' +
    // Belt-and-suspenders — avoids FOIT if any local @font-face is added later.
    '@font-face{font-display:swap}';
  return `<style>${css}</style>`;
}

export async function buildHtml(input: BuildHtmlInput): Promise<BuildHtmlOutput> {
  const { templateName, slots, language } = input;
  const Component = TEMPLATES[templateName];
  if (!Component) {
    throw new Error(`Unknown template: ${templateName}`);
  }

  // React SSR — bodyHtml contains <style> tag with CSS custom properties.
  // Cast: TEMPLATES is a union of components with heterogeneous prop shapes
  // (TemplateSlots vs BepurexSlots). At runtime templates gracefully handle
  // missing optional fields; the shape is validated at the composer boundary.
  const bodyHtml = renderToString(
    createElement(Component as React.ComponentType<BuildHtmlSlots>, slots),
  );

  // Font pre-load + stylesheet from Google Fonts.
  // Guard: legacy callers may not supply brand.typography — skip injection.
  const hasTypography = Boolean(slots.brand?.typography?.headline_font && slots.brand?.typography?.body_font);
  const fontsHref = hasTypography
    ? buildGoogleFontsHref(
        slots.brand.typography.headline_font,
        slots.brand.typography.body_font,
      )
    : null;

  const hasPalette = Boolean(slots.brand?.palette);
  const identityStyle = hasPalette ? buildIdentityStyleTag(slots.brand) : '';

  const headParts: string[] = [
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Placeholder: seo-optimizer replaces these <!-- SEO --> markers.
    '<!-- SEO_HEAD_PLACEHOLDER -->',
  ];
  if (fontsHref) {
    headParts.push(
      '<link rel="preconnect" href="https://fonts.googleapis.com">',
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
      `<link rel="preload" href="${fontsHref}" as="style">`,
      `<link rel="stylesheet" href="${fontsHref}">`,
    );
  }
  if (identityStyle) {
    headParts.push(identityStyle);
  }

  const doc = [
    '<!DOCTYPE html>',
    `<html lang="${language}">`,
    '<head>',
    ...headParts,
    '</head>',
    '<body>',
    bodyHtml,
    '</body>',
    '</html>',
  ].join('');

  // Minify — protect CSS custom properties (var(--x)) by keeping level 1 CSS
  // minification only (level 2 would rewrite selectors and can break inline
  // React SSR classNames). @sm risk mitigation from Wave 1.
  let minified: string;
  try {
    minified = await minify(doc, {
      collapseWhitespace: true,
      removeComments: true,
      minifyCSS: { level: 1 },
      minifyJS: true,
      removeAttributeQuotes: false,
      keepClosingSlash: true,
      caseSensitive: true,
    });
  } catch {
    // Minifier is defense-only — if it fails, ship the unminified doc.
    minified = doc;
  }

  return {
    html: minified,
    size_bytes: Buffer.byteLength(minified, 'utf8'),
  };
}

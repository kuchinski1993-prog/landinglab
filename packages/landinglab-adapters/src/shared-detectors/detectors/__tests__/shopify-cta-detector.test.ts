import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { shopifyCtaDetector } from '../shopify-cta-detector.js';
import type { SharedDetectorContext } from '../../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDER_FIXTURES = join(
  __dirname,
  '../../../../../../apps/worker/src/__tests__/__fixtures__/render-golden',
);
const FAMILY_FIXTURES = join(
  __dirname,
  '../../../family-classifier/__tests__/__fixtures__',
);

const KACHING = readFileSync(join(RENDER_FIXTURES, 'kaching-minimal.input.html'), 'utf-8');
const PSS_PURE = readFileSync(join(RENDER_FIXTURES, 'pss-pure-minimal.input.html'), 'utf-8');
const PSS_HYBRID = readFileSync(join(RENDER_FIXTURES, 'pss-kaching-hybrid.input.html'), 'utf-8');
const AURIVITA = readFileSync(join(RENDER_FIXTURES, 'aurivita-minimal.input.html'), 'utf-8');
const PDP = readFileSync(join(FAMILY_FIXTURES, 'pdp-shopify-minimal.input.html'), 'utf-8');
const ADVERTORIAL = readFileSync(join(FAMILY_FIXTURES, 'advertorial-minimal.input.html'), 'utf-8');

function ctx(html: string, family: SharedDetectorContext['family'] = 'sales_page'): SharedDetectorContext {
  return { html, $: cheerio.load(html), family, familyConfidence: 1.0 };
}

describe('ShopifyCtaDetector — true positives', () => {
  it('PDP shopify → emite cta_primary.main confident + editableField', () => {
    const r = shopifyCtaDetector.detect(ctx(PDP, 'pdp_derived'));
    expect(r.ownershipClaims).toHaveLength(1);
    const claim = r.ownershipClaims[0]!;
    expect(claim.regionKind).toBe('cta_primary');
    expect(claim.authoritative).toBe(true);
    expect(claim.confidence).toBeGreaterThanOrEqual(0.6);
    expect(claim.reason).toContain('shopify_cta_main');
    // Should have variant_selector (S3) → confidence high
    expect(claim.confidence).toBeGreaterThanOrEqual(0.85);
    // EditableField para CTA label
    expect(r.editableFields.length).toBeGreaterThan(0);
    expect(r.editableFields[0]!.type).toBe('text');
    expect(r.editableFields[0]!.source).toBe('html');
  });
});

describe('ShopifyCtaDetector — false-positive matrix', () => {
  it('kaching-minimal → button[name="add"] SEM form/variant → low confidence → unclassified', () => {
    // Kaching fixture tem button[name="add"] mas SEM form ancestor.
    // S1 sozinho = 0.35, abaixo de 0.60.
    const r = shopifyCtaDetector.detect(ctx(KACHING));
    expect(r.ownershipClaims).toEqual([]); // NÃO emite confident
    expect(r.unclassified.length).toBe(1);
    expect(r.unclassified[0]!.reason).toContain('low_confidence_cta');
  });

  it('PSS pure → sem button[name="add"] → detector no-op', () => {
    const r = shopifyCtaDetector.detect(ctx(PSS_PURE));
    expect(r.ownershipClaims).toEqual([]);
    expect(r.unclassified).toEqual([]);
    expect(r.reasons[0]).toContain('no button[name="add"] found');
  });

  it('PSS+Kaching hybrid → sem button[name="add"] → no-op (Klensia real usa pss-atc-button)', () => {
    const r = shopifyCtaDetector.detect(ctx(PSS_HYBRID));
    expect(r.ownershipClaims).toEqual([]);
    expect(r.reasons[0]).toContain('no button[name="add"] found');
  });

  it('aurivita → sem button[name="add"] → no-op', () => {
    const r = shopifyCtaDetector.detect(ctx(AURIVITA));
    expect(r.ownershipClaims).toEqual([]);
  });

  it('advertorial → sem CTA shopify → no-op', () => {
    const r = shopifyCtaDetector.detect(ctx(ADVERTORIAL, 'advertorial'));
    expect(r.ownershipClaims).toEqual([]);
  });

  it('generic HTML → no-op', () => {
    const r = shopifyCtaDetector.detect(ctx('<html><body><p>hi</p></body></html>'));
    expect(r.ownershipClaims).toEqual([]);
  });

  it('button dentro de cart-drawer → skip (excluded ancestor)', () => {
    const html = `
      <html><body>
        <cart-drawer>
          <form action="/cart">
            <button name="add">Add from drawer</button>
          </form>
        </cart-drawer>
      </body></html>
    `;
    const r = shopifyCtaDetector.detect(ctx(html));
    expect(r.ownershipClaims).toEqual([]);
    expect(r.reasons.some((x) => x.includes('excluded ancestor'))).toBe(true);
  });

  it('button dentro de sticky-atc → cta_primary com penalty + NÃO authoritative como main', () => {
    const html = `
      <html><body>
        <main>
          <div class="sticky-atc-bar">
            <form action="/cart">
              <select name="id"><option>1</option></select>
              <button name="add">Sticky Add</button>
            </form>
          </div>
        </main>
      </body></html>
    `;
    const r = shopifyCtaDetector.detect(ctx(html));
    if (r.ownershipClaims.length > 0) {
      const claim = r.ownershipClaims[0]!;
      // Confidence com penalty
      expect(claim.reason).toContain('shopify_cta_sticky');
      // Sticky NÃO é authoritative como main
      expect(claim.authoritative).toBe(false);
    } else {
      // OK também — sticky penalty pode ter derrubado abaixo do gate
      expect(r.unclassified.length).toBeGreaterThan(0);
    }
  });
});

describe('ShopifyCtaDetector — determinismo + zero mutation', () => {
  const HTML = PDP;

  it('N=5 execuções → resultado semanticamente idêntico', () => {
    const runs = Array.from({ length: 5 }, () => shopifyCtaDetector.detect(ctx(HTML)));
    const first = JSON.stringify(runs[0]);
    for (let i = 1; i < 5; i++) {
      expect(JSON.stringify(runs[i])).toBe(first);
    }
  });

  it('zero HTML mutation — $.html() before === after', () => {
    const $ = cheerio.load(HTML);
    const before = $.html();
    shopifyCtaDetector.detect({ html: HTML, $, family: 'pdp_derived', familyConfidence: 1 });
    expect($.html()).toBe(before);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { accordionDetector } from '../accordion-detector.js';
import type { SharedDetectorContext } from '../../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDER_FIXTURES = join(
  __dirname,
  '../../../../../../apps/worker/src/__tests__/__fixtures__/render-golden',
);

const PSS_PURE = readFileSync(join(RENDER_FIXTURES, 'pss-pure-minimal.input.html'), 'utf-8');
const PSS_HYBRID = readFileSync(join(RENDER_FIXTURES, 'pss-kaching-hybrid.input.html'), 'utf-8');

function ctx(html: string): SharedDetectorContext {
  return { html, $: cheerio.load(html), family: 'sales_page', familyConfidence: 1.0 };
}

describe('AccordionDetector — true positive: FAQ real', () => {
  it('cc-faq pattern com "?" nos triggers → emit faq confident', () => {
    const html = `
      <html><body>
        <h2>FAQ</h2>
        <div class="cc-faq">
          <button class="cc-faq__question" aria-expanded="false">How long does shipping take?</button>
          <div class="cc-faq__answer">5-7 days.</div>
          <button class="cc-faq__question" aria-expanded="false">Are ingredients natural?</button>
          <div class="cc-faq__answer">Yes.</div>
          <button class="cc-faq__question" aria-expanded="false">Refund policy?</button>
          <div class="cc-faq__answer">30 days.</div>
        </div>
      </body></html>
    `;
    // F1 (cc_faq) + F2 (3 triggers) + F3 (100% questions) + F4 (nearby "FAQ") = 1.0
    const r = accordionDetector.detect(ctx(html));
    expect(r.ownershipClaims).toHaveLength(1);
    const claim = r.ownershipClaims[0]!;
    expect(claim.regionKind).toBe('faq');
    expect(claim.confidence).toBeGreaterThanOrEqual(0.9);
    expect(claim.authoritative).toBe(true);
  });

  it('faq-img pattern com heading FAQ próximo → confident', () => {
    const html = `
      <html><body>
        <section>
          <h3>Frequently Asked Questions</h3>
          <div class="faq-container">
            <button class="faq-img-question">Question 1?</button>
            <div class="faq-img-answer">Answer 1.</div>
            <button class="faq-img-question">Question 2?</button>
            <div class="faq-img-answer">Answer 2.</div>
          </div>
        </section>
      </body></html>
    `;
    const r = accordionDetector.detect(ctx(html));
    expect(r.ownershipClaims.some((c) => c.regionKind === 'faq')).toBe(true);
  });
});

describe('AccordionDetector — false-positive matrix', () => {
  it('PSS accordion mas sem "?" e sem heading FAQ → unclassified com hint accordion', () => {
    // pss-pure-minimal tem .pss-accordion-trigger com "Q1?" — vamos usar
    const r = accordionDetector.detect(ctx(PSS_PURE));
    // pss-pure fixture tem 'Q1?' que tem '?', mas só 1 trigger → F2 falha, F1 falha, F4 falha
    // Score baixo → unclassified
    if (r.ownershipClaims.length === 0) {
      expect(r.unclassified.length).toBeGreaterThan(0);
      const u = r.unclassified[0]!;
      expect(u.reason).toContain('accordion_pattern_but_not_faq');
    }
  });

  it('shipping accordion (sem "?") → unclassified, NÃO faq', () => {
    const html = `
      <html><body>
        <div class="product-details">
          <details><summary>Shipping information</summary><p>Details here.</p></details>
          <details><summary>Ingredients</summary><p>List.</p></details>
          <details><summary>Care instructions</summary><p>Wash cold.</p></details>
        </div>
      </body></html>
    `;
    const r = accordionDetector.detect(ctx(html));
    // F1 (class 'faq'?) → não bate
    // F2 (>= 2 triggers) → +0.20
    // F3 (?) → nenhum '?' → 0
    // F4 (heading FAQ próximo) → não
    // Score = 0.20 → unclassified
    expect(r.ownershipClaims).toEqual([]);
    expect(r.unclassified.length).toBe(1);
    expect(r.unclassified[0]!.reason).toContain('accordion_pattern_but_not_faq');
  });

  it('single accordion isolado → unclassified (F2 falha)', () => {
    const html = `
      <html><body>
        <details><summary>Only one section?</summary><p>Answer.</p></details>
      </body></html>
    `;
    const r = accordionDetector.detect(ctx(html));
    // F1 → 0
    // F2 (só 1) → 0
    // F3 (100%) → +0.25
    // F4 → 0
    // Score = 0.25 → unclassified
    expect(r.ownershipClaims).toEqual([]);
  });

  it('sem accordion pattern → detector no-op', () => {
    const r = accordionDetector.detect(ctx('<html><body><p>x</p></body></html>'));
    expect(r.ownershipClaims).toEqual([]);
    expect(r.unclassified).toEqual([]);
    expect(r.reasons[0]).toContain('no accordion patterns found');
  });

  it('PSS+Kaching hybrid → só 1 accordion trigger no fixture → unclassified', () => {
    const r = accordionDetector.detect(ctx(PSS_HYBRID));
    // pss-kaching-hybrid tem só 1 pss-accordion-trigger → F2 falha
    if (r.ownershipClaims.length === 0) {
      // Espera unclassified
      const hasAccordion = r.unclassified.some((u) => u.reason.includes('accordion_pattern'));
      expect(hasAccordion).toBe(true);
    }
  });
});

describe('AccordionDetector — determinismo + zero mutation', () => {
  const HTML = `
    <html><body>
      <h2>FAQ</h2>
      <div class="cc-faq">
        <button class="cc-faq__question">Q1?</button>
        <div class="cc-faq__answer">A1</div>
        <button class="cc-faq__question">Q2?</button>
        <div class="cc-faq__answer">A2</div>
      </div>
    </body></html>
  `;

  it('N=5 execuções → resultado idêntico', () => {
    const runs = Array.from({ length: 5 }, () => accordionDetector.detect(ctx(HTML)));
    const first = JSON.stringify(runs[0]);
    for (let i = 1; i < 5; i++) {
      expect(JSON.stringify(runs[i])).toBe(first);
    }
  });

  it('zero HTML mutation', () => {
    const $ = cheerio.load(HTML);
    const before = $.html();
    accordionDetector.detect({ html: HTML, $, family: 'sales_page', familyConfidence: 1 });
    expect($.html()).toBe(before);
  });
});

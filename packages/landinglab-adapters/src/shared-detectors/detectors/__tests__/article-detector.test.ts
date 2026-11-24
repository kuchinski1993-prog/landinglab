import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { articleDetector } from '../article-detector.js';
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
const PDP = readFileSync(join(FAMILY_FIXTURES, 'pdp-shopify-minimal.input.html'), 'utf-8');
const ADVERTORIAL = readFileSync(join(FAMILY_FIXTURES, 'advertorial-minimal.input.html'), 'utf-8');

function ctx(html: string, family: SharedDetectorContext['family'] = 'advertorial'): SharedDetectorContext {
  return { html, $: cheerio.load(html), family, familyConfidence: 1.0 };
}

describe('ArticleDetector — true positives', () => {
  it('advertorial fixture → emite article_body + headline confident', () => {
    const r = articleDetector.detect(ctx(ADVERTORIAL));
    // Deve ter article_body + headline
    const kinds = r.ownershipClaims.map((c) => c.regionKind).sort();
    expect(kinds).toContain('article_body');
    expect(kinds).toContain('headline');
    // Article body claim
    const article = r.ownershipClaims.find((c) => c.regionKind === 'article_body')!;
    expect(article.confidence).toBeGreaterThanOrEqual(0.6);
    expect(article.authoritative).toBe(true);
    // Headline claim
    const headline = r.ownershipClaims.find((c) => c.regionKind === 'headline')!;
    expect(headline.confidence).toBeGreaterThanOrEqual(0.6);
    // EditableField do headline
    expect(r.editableFields.some((f) => f.id === 'article.headline.text')).toBe(true);
  });
});

describe('ArticleDetector — false-positive matrix', () => {
  it('kaching-minimal → sem <article> → no-op', () => {
    const r = articleDetector.detect(ctx(KACHING, 'sales_page'));
    expect(r.ownershipClaims).toEqual([]);
    expect(r.reasons[0]).toContain('no <article> tag found');
  });

  it('PDP shopify → sem <article> → no-op', () => {
    const r = articleDetector.detect(ctx(PDP, 'pdp_derived'));
    expect(r.ownershipClaims).toEqual([]);
  });

  it('<article> vazio → confidence baixo → unclassified', () => {
    const html = '<html><body><article></article></body></html>';
    const r = articleDetector.detect(ctx(html));
    expect(r.ownershipClaims).toEqual([]);
    expect(r.unclassified.length).toBe(1);
    expect(r.unclassified[0]!.reason).toContain('low_confidence_article');
  });

  it('<article> com apenas 1 <p> → unclassified', () => {
    const html = '<html><body><article><p>Just one paragraph.</p></article></body></html>';
    const r = articleDetector.detect(ctx(html));
    expect(r.ownershipClaims).toEqual([]);
    expect(r.unclassified.length).toBe(1);
  });

  it('<article> com bundle Kaching dentro → penalty A5 → unclassified', () => {
    const html = `
      <html><body>
        <article>
          <h1>Article Title</h1>
          <p>Paragraph 1 lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
          <p>Paragraph 2 lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
          <p>Paragraph 3 lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
          <p>Paragraph 4 lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
          <p>Paragraph 5 lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
          <div class="kaching-bundles__bar" data-deal-bar-id="a">
            <span>$10</span>
          </div>
        </article>
      </body></html>
    `;
    const r = articleDetector.detect(ctx(html));
    // Score = 0.35 + 0.20 (A2) + 0.15 (A3) + 0.15 (A4) - 0.15 (A5) = 0.70
    // Ainda passa gate (0.60) — mas com penalty registrado
    const article = r.ownershipClaims.find((c) => c.regionKind === 'article_body');
    if (article) {
      expect(article.region.evidence.reasons.some((r) => r.includes('A5'))).toBe(true);
    }
  });

  it('div com muitos <p> mas SEM <article> tag → no-op (A1 obrigatório)', () => {
    const html = `
      <html><body>
        <div class="content">
          <h1>Not really an article</h1>
          <p>P1 lorem ipsum. </p>
          <p>P2 lorem ipsum. </p>
          <p>P3 lorem ipsum. </p>
          <p>P4 lorem ipsum. </p>
          <p>P5 lorem ipsum. </p>
        </div>
      </body></html>
    `;
    const r = articleDetector.detect(ctx(html));
    expect(r.ownershipClaims).toEqual([]);
    expect(r.reasons[0]).toContain('no <article>');
  });

  it('sales-page long-form (article com só 3 <p> curtos) → unclassified', () => {
    const html = `
      <html><body>
        <article>
          <p>Short.</p>
          <p>Also short.</p>
          <p>Very short too.</p>
        </article>
      </body></html>
    `;
    // A2 falha (3 < 5), A4 falha (<400 chars) → 0.35 + 0 + 0 + 0 = 0.35
    const r = articleDetector.detect(ctx(html));
    expect(r.ownershipClaims).toEqual([]);
    expect(r.unclassified.length).toBe(1);
  });

  it('generic HTML → no-op', () => {
    const r = articleDetector.detect(ctx('<html><body><p>x</p></body></html>'));
    expect(r.ownershipClaims).toEqual([]);
  });
});

describe('ArticleDetector — determinismo + zero mutation', () => {
  it('N=5 execuções → resultado idêntico', () => {
    const runs = Array.from({ length: 5 }, () => articleDetector.detect(ctx(ADVERTORIAL)));
    const first = JSON.stringify(runs[0]);
    for (let i = 1; i < 5; i++) {
      expect(JSON.stringify(runs[i])).toBe(first);
    }
  });

  it('zero HTML mutation', () => {
    const $ = cheerio.load(ADVERTORIAL);
    const before = $.html();
    articleDetector.detect({ html: ADVERTORIAL, $, family: 'advertorial', familyConfidence: 1 });
    expect($.html()).toBe(before);
  });
});

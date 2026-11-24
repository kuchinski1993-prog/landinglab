import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { footerDetector } from '../footer-detector.js';
import type { SharedDetectorContext } from '../../types.js';

function ctx(html: string): SharedDetectorContext {
  return { html, $: cheerio.load(html), family: 'sales_page', familyConfidence: 1.0 };
}

describe('FooterDetector — true positives', () => {
  it('<footer> tag → confident', () => {
    const html = '<html><body><footer><p>© 2026</p></footer></body></html>';
    const r = footerDetector.detect(ctx(html));
    expect(r.ownershipClaims).toHaveLength(1);
    const claim = r.ownershipClaims[0]!;
    expect(claim.regionKind).toBe('footer');
    expect(claim.confidence).toBeGreaterThanOrEqual(0.85);
    expect(claim.authoritative).toBe(true);
  });

  it('role="contentinfo" → confident (menor que footer tag)', () => {
    const html = '<html><body><div role="contentinfo"><p>© 2026</p></div></body></html>';
    const r = footerDetector.detect(ctx(html));
    expect(r.ownershipClaims).toHaveLength(1);
    const claim = r.ownershipClaims[0]!;
    expect(claim.confidence).toBeGreaterThanOrEqual(0.75);
    expect(claim.confidence).toBeLessThan(0.85);
  });
});

describe('FooterDetector — false-positive matrix', () => {
  it('div.footer (só class, sem tag) → NÃO detecta', () => {
    const html = '<html><body><div class="footer"><p>Fake footer</p></div></body></html>';
    const r = footerDetector.detect(ctx(html));
    expect(r.ownershipClaims).toEqual([]);
  });

  it('last big container (heurística ruim) → NÃO detecta', () => {
    const html = `
      <html><body>
        <main><p>Content</p></main>
        <div><p>Some final section but not tagged as footer</p></div>
      </body></html>
    `;
    const r = footerDetector.detect(ctx(html));
    expect(r.ownershipClaims).toEqual([]);
    expect(r.reasons[0]).toContain('no <footer> or role="contentinfo"');
  });

  it('sem footer nenhum → no-op', () => {
    const r = footerDetector.detect(ctx('<html><body><p>x</p></body></html>'));
    expect(r.ownershipClaims).toEqual([]);
  });
});

describe('FooterDetector — determinismo + zero mutation', () => {
  const HTML = '<html><body><footer>© 2026</footer></body></html>';

  it('N=5 → idêntico', () => {
    const runs = Array.from({ length: 5 }, () => footerDetector.detect(ctx(HTML)));
    const first = JSON.stringify(runs[0]);
    for (let i = 1; i < 5; i++) expect(JSON.stringify(runs[i])).toBe(first);
  });

  it('zero HTML mutation', () => {
    const $ = cheerio.load(HTML);
    const before = $.html();
    footerDetector.detect({ html: HTML, $, family: 'sales_page', familyConfidence: 1 });
    expect($.html()).toBe(before);
  });
});

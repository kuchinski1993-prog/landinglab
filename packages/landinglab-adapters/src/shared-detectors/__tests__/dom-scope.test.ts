import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
  buildDomScope,
  scopeContains,
  scopeEquals,
  scopeOverlaps,
} from '../index.js';

const HTML = `
<html>
  <body>
    <main>
      <section>
        <h1>Title</h1>
        <p>P1</p>
        <p>P2</p>
      </section>
      <section>
        <h2>Sub</h2>
      </section>
    </main>
    <footer>
      <a href="#">Link</a>
    </footer>
  </body>
</html>
`;

describe('DomScope build + identity', () => {
  it('mesmo elemento no mesmo DOM → mesmo structuralPath + instanceId', () => {
    const $a = cheerio.load(HTML);
    const $b = cheerio.load(HTML);
    const h1a = $a('h1').get(0)!;
    const h1b = $b('h1').get(0)!;
    const scopeA = buildDomScope($a, h1a);
    const scopeB = buildDomScope($b, h1b);
    expect(scopeA.structuralPath).toBe(scopeB.structuralPath);
    expect(scopeA.instanceId).toBe(scopeB.instanceId);
  });

  it('duas sections irmãs → paths diferentes + instanceIds diferentes', () => {
    const $ = cheerio.load(HTML);
    const s1 = $('section').get(0)!;
    const s2 = $('section').get(1)!;
    const sc1 = buildDomScope($, s1);
    const sc2 = buildDomScope($, s2);
    expect(sc1.structuralPath).not.toBe(sc2.structuralPath);
    expect(sc1.instanceId).not.toBe(sc2.instanceId);
  });

  it('instanceId é hex 12 chars', () => {
    const $ = cheerio.load(HTML);
    const scope = buildDomScope($, $('h1').get(0)!);
    expect(scope.instanceId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('selector é diagnóstico usando primeira classe/data-attr/tagName', () => {
    const $ = cheerio.load(`
      <html><body>
        <div class="foo bar" id="ignore-me-id"><p>X</p></div>
      </body></html>
    `);
    const scope = buildDomScope($, $('div').get(0)!);
    // Prefere id > data-attr > class > tag
    expect(scope.selector).toBe('div#ignore-me-id');
  });
});

describe('scope relations', () => {
  const $ = cheerio.load(HTML);
  const mainScope = buildDomScope($, $('main').get(0)!);
  const firstSection = buildDomScope($, $('section').get(0)!);
  const secondSection = buildDomScope($, $('section').get(1)!);
  const h1Scope = buildDomScope($, $('h1').get(0)!);
  const footerScope = buildDomScope($, $('footer').get(0)!);

  it('scopeEquals: mesma referência → true', () => {
    const again = buildDomScope($, $('main').get(0)!);
    expect(scopeEquals(mainScope, again)).toBe(true);
  });

  it('scopeContains: main contém section', () => {
    expect(scopeContains(mainScope, firstSection)).toBe(true);
    expect(scopeContains(firstSection, mainScope)).toBe(false);
  });

  it('scopeContains: section 1 contém h1', () => {
    expect(scopeContains(firstSection, h1Scope)).toBe(true);
  });

  it('scopeContains: mesma referência → false (não é ancestor de si)', () => {
    const again = buildDomScope($, $('main').get(0)!);
    expect(scopeContains(mainScope, again)).toBe(false);
  });

  it('duas sections irmãs: não overlap', () => {
    expect(scopeOverlaps(firstSection, secondSection)).toBe(false);
  });

  it('main vs footer: sem overlap (irmãos)', () => {
    expect(scopeOverlaps(mainScope, footerScope)).toBe(false);
  });

  it('main vs h1 (descendant): overlap true', () => {
    expect(scopeOverlaps(mainScope, h1Scope)).toBe(true);
  });
});

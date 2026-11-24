import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { computeTextBlocks } from '../mapper.js';
import type { EditableField } from '../../types/editable-field.js';
import type { RegionEntry } from '../../semantic-mapper/types.js';
import { buildDomScope } from '../../shared-detectors/dom-scope.js';
import { criticalityOf } from '../../types/semantic-region.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAMILY_FIXTURES = join(
  __dirname,
  '../../family-classifier/__tests__/__fixtures__',
);

const ADVERTORIAL = readFileSync(
  join(FAMILY_FIXTURES, 'advertorial-minimal.input.html'),
  'utf-8',
);

// ─────────────────────────────────────────────────────────────

describe('computeTextBlocks — EditableFields como source', () => {
  it('article.headline.text (editable) → headline block', () => {
    const editable: EditableField[] = [
      {
        id: 'article.headline.text',
        region: 'headline',
        type: 'text',
        source: 'html',
        criticality: 'non_critical',
        value: 'Big Title',
        confidence: 0.9,
        capabilities: ['edit', 'translate'],
        label: 'Headline',
      },
    ];
    const r = computeTextBlocks({ html: '<html><body></body></html>', editableFields: editable });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]!.blockKind).toBe('headline');
    expect(r.blocks[0]!.content).toBe('Big Title');
    expect(r.blocks[0]!.capabilities).toEqual(['edit', 'translate']);
  });

  it('cta_primary.main.label → cta_label block', () => {
    const editable: EditableField[] = [
      {
        id: 'cta_primary.main.label',
        region: 'cta_primary',
        type: 'text',
        source: 'html',
        criticality: 'critical',
        value: 'Add to Cart',
        confidence: 0.9,
        capabilities: ['edit', 'translate'],
        label: 'CTA main label',
      },
    ];
    const r = computeTextBlocks({ html: '<html><body></body></html>', editableFields: editable });
    expect(r.blocks[0]!.blockKind).toBe('cta_label');
  });

  it('EditableField com source=canonical → SKIP (não é html)', () => {
    const editable: EditableField[] = [
      {
        id: 'bundles.offer.0.price',
        region: 'bundles',
        type: 'price',
        source: 'canonical',
        criticality: 'critical',
        reference: { table: 'landing_bundle_offers', column: 'price_cents' },
        confidence: 0.9,
        capabilities: ['edit'],
        label: 'Preço',
      },
    ];
    const r = computeTextBlocks({ html: '<html><body></body></html>', editableFields: editable });
    expect(r.blocks).toEqual([]);
  });
});

describe('computeTextBlocks — Regions confirmadas', () => {
  function buildArticleRegion(html: string): RegionEntry {
    const $ = cheerio.load(html);
    const el = $('article').get(0)!;
    const scope = buildDomScope($, el);
    return {
      kind: 'article_body',
      source: 'shared_detector',
      ownerId: 'article',
      region: {
        kind: 'article_body',
        selector: 'article',
        evidence: { reasons: [], matchedRules: [] },
        confidence: 0.85,
        criticality: criticalityOf('article_body'),
      },
      instanceId: scope.instanceId,
      structuralPath: scope.structuralPath,
      confidence: 0.85,
    };
  }

  it('article_body region → paragraphs viram article_paragraph blocks', () => {
    const regions = [buildArticleRegion(ADVERTORIAL)];
    const r = computeTextBlocks({ html: ADVERTORIAL, regions });
    const paragraphs = r.blocks.filter((b) => b.blockKind === 'article_paragraph');
    expect(paragraphs.length).toBeGreaterThan(0);
    expect(paragraphs[0]!.regionKind).toBe('article_body');
    expect(paragraphs[0]!.capabilities).toEqual(['edit', 'translate']);
  });

  it('paragraphs < 20 chars → skip', () => {
    const html = `
      <html><body>
        <article>
          <p>Short.</p>
          <p>Also short.</p>
          <p>This paragraph is long enough to be included in the results.</p>
        </article>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const scope = buildDomScope($, $('article').get(0)!);
    const region: RegionEntry = {
      kind: 'article_body',
      source: 'shared_detector',
      ownerId: 'article',
      region: {
        kind: 'article_body',
        selector: 'article',
        evidence: { reasons: [], matchedRules: [] },
        confidence: 0.85,
        criticality: criticalityOf('article_body'),
      },
      instanceId: scope.instanceId,
      structuralPath: scope.structuralPath,
      confidence: 0.85,
    };
    const r = computeTextBlocks({ html, regions: [region] });
    const paras = r.blocks.filter((b) => b.blockKind === 'article_paragraph');
    expect(paras).toHaveLength(1);
    expect(paras[0]!.content).toContain('long enough');
  });

  it('faq region → question + answer pairs', () => {
    const html = `
      <html><body>
        <div class="cc-faq">
          <button class="cc-faq__question">How long?</button>
          <div class="cc-faq__answer">5 days.</div>
          <button class="cc-faq__question">Refund?</button>
          <div class="cc-faq__answer">30 days.</div>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const scope = buildDomScope($, $('.cc-faq').get(0)!);
    const region: RegionEntry = {
      kind: 'faq',
      source: 'shared_detector',
      ownerId: 'accordion',
      region: {
        kind: 'faq',
        selector: '.cc-faq',
        evidence: { reasons: [], matchedRules: [] },
        confidence: 0.9,
        criticality: criticalityOf('faq'),
      },
      instanceId: scope.instanceId,
      structuralPath: scope.structuralPath,
      confidence: 0.9,
    };
    const r = computeTextBlocks({ html, regions: [region] });
    const questions = r.blocks.filter((b) => b.blockKind === 'faq_question');
    const answers = r.blocks.filter((b) => b.blockKind === 'faq_answer');
    expect(questions.length).toBe(2);
    expect(answers.length).toBe(2);
    expect(questions[0]!.content).toBe('How long?');
    expect(answers[0]!.content).toBe('5 days.');
  });

  it('footer region → single footer_text block agregado', () => {
    const html = `
      <html><body>
        <footer>© 2026 · Contact us · Privacy</footer>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const scope = buildDomScope($, $('footer').get(0)!);
    const region: RegionEntry = {
      kind: 'footer',
      source: 'shared_detector',
      ownerId: 'footer',
      region: {
        kind: 'footer',
        selector: 'footer',
        evidence: { reasons: [], matchedRules: [] },
        confidence: 0.85,
        criticality: criticalityOf('footer'),
      },
      instanceId: scope.instanceId,
      structuralPath: scope.structuralPath,
      confidence: 0.85,
    };
    const r = computeTextBlocks({ html, regions: [region] });
    const footer = r.blocks.filter((b) => b.blockKind === 'footer_text');
    expect(footer).toHaveLength(1);
    expect(footer[0]!.content).toContain('2026');
  });
});

describe('computeTextBlocks — negative cases', () => {
  it('sem regions e sem editable fields → sem blocks', () => {
    const r = computeTextBlocks({ html: '<html><body><p>x</p></body></html>' });
    expect(r.blocks).toEqual([]);
  });

  it('não faz text walker global (não emite p aleatório fora de scope)', () => {
    const html = `
      <html><body>
        <div><p>Random unrelated paragraph outside any region.</p></div>
      </body></html>
    `;
    const r = computeTextBlocks({ html });
    expect(r.blocks).toEqual([]);
  });

  it('regions vazio + editableFields vazio → sem blocks', () => {
    const r = computeTextBlocks({ html: ADVERTORIAL, regions: [], editableFields: [] });
    expect(r.blocks).toEqual([]);
  });
});

describe('computeTextBlocks — determinismo + zero mutation', () => {
  it('N=3 idêntico', () => {
    const editable: EditableField[] = [
      {
        id: 'article.headline.text',
        region: 'headline',
        type: 'text',
        source: 'html',
        criticality: 'non_critical',
        value: 'X',
        confidence: 0.8,
        capabilities: ['edit', 'translate'],
        label: 'Head',
      },
    ];
    const runs = Array.from({ length: 3 }, () =>
      computeTextBlocks({ html: '<html><body></body></html>', editableFields: editable }),
    );
    const first = JSON.stringify(runs[0]);
    for (let i = 1; i < 3; i++) expect(JSON.stringify(runs[i])).toBe(first);
  });

  it('input html não mutado', () => {
    const before = ADVERTORIAL;
    computeTextBlocks({ html: before });
    expect(before).toBe(ADVERTORIAL);
  });
});

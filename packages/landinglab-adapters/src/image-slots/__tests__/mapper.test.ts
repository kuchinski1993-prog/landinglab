import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { computeImageSlots } from '../mapper.js';
import type { ImageOcrMetadataEntry } from '../types.js';
import type { RegionEntry } from '../../semantic-mapper/types.js';
import { buildDomScope } from '../../shared-detectors/dom-scope.js';
import { criticalityOf } from '../../types/semantic-region.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAMILY_FIXTURES = join(
  __dirname,
  '../../family-classifier/__tests__/__fixtures__',
);
const RENDER_FIXTURES = join(
  __dirname,
  '../../../../../apps/worker/src/__tests__/__fixtures__/render-golden',
);

const ADVERTORIAL = readFileSync(join(FAMILY_FIXTURES, 'advertorial-minimal.input.html'), 'utf-8');
const PDP = readFileSync(join(FAMILY_FIXTURES, 'pdp-shopify-minimal.input.html'), 'utf-8');
const KACHING = readFileSync(join(RENDER_FIXTURES, 'kaching-minimal.input.html'), 'utf-8');

// ─────────────────────────────────────────────────────────────

describe('computeImageSlots — advertorial', () => {
  it('imagens dentro de <article> → advertorial_image', () => {
    // Adiciona imagem sintética no advertorial
    const html = ADVERTORIAL.replace(
      '<article>',
      '<article><img src="/adv-hero.jpg" alt="Adv hero">',
    );
    const r = computeImageSlots({ html });
    const advSlots = r.slots.filter((s) => s.slotKind === 'advertorial_image');
    expect(advSlots.length).toBeGreaterThan(0);
    expect(advSlots[0]!.regionKind).toBe('article_body');
    expect(advSlots[0]!.confidence).toBeGreaterThanOrEqual(0.8);
  });
});

describe('computeImageSlots — PDP produto', () => {
  it('imagens dentro de .product-media → product_main OR gallery_image', () => {
    const r = computeImageSlots({ html: PDP });
    // pdp-shopify-minimal tem 3 imgs em .product-media
    const relevant = r.slots.filter(
      (s) => s.slotKind === 'product_main' || s.slotKind === 'gallery_image',
    );
    expect(relevant.length).toBeGreaterThan(0);
  });
});

describe('computeImageSlots — logo detection', () => {
  it('img dentro de <header> com alt="logo" → logo', () => {
    const html = `
      <html><body>
        <header><img src="/logo.png" alt="Company Logo"></header>
      </body></html>
    `;
    const r = computeImageSlots({ html });
    expect(r.slots).toHaveLength(1);
    expect(r.slots[0]!.slotKind).toBe('logo');
  });

  it('OCR badge+hasBrandOrigin sozinho → logo confidence média', () => {
    const html = '<html><body><footer><img src="/badge.png" alt=""></footer></body></html>';
    const ocr: ImageOcrMetadataEntry[] = [
      { url: '/badge.png', category: 'badge', hasBrandOrigin: true },
    ];
    const r = computeImageSlots({ html, ocrMetadata: ocr });
    expect(r.slots[0]!.slotKind).toBe('logo');
  });
});

describe('computeImageSlots — decorative', () => {
  it('img pequena com alt="" → decorative', () => {
    const html = '<html><body><img src="/icon.svg" alt="" width="24" height="24"></body></html>';
    const r = computeImageSlots({ html });
    expect(r.slots[0]!.slotKind).toBe('decorative');
  });

  it('img class="icon" com alt="" → decorative', () => {
    const html = '<html><body><img src="/star.png" alt="" class="icon rating"></body></html>';
    const r = computeImageSlots({ html });
    expect(r.slots[0]!.slotKind).toBe('decorative');
  });
});

describe('computeImageSlots — unknown fallback', () => {
  it('img isolada sem contexto → unknown', () => {
    const html = '<html><body><img src="/isolated.jpg" alt="Just an image"></body></html>';
    const r = computeImageSlots({ html });
    expect(r.slots[0]!.slotKind).toBe('unknown');
  });

  it('OCR product mas SEM contexto DOM → NÃO promove pra product_main', () => {
    const html = '<html><body><img src="/x.jpg" alt="X"></body></html>';
    const ocr: ImageOcrMetadataEntry[] = [{ url: '/x.jpg', category: 'product' }];
    const r = computeImageSlots({ html, ocrMetadata: ocr });
    // Sem <main> ancestor → cai em unknown
    expect(r.slots[0]!.slotKind).toBe('unknown');
    expect(r.slots[0]!.evidence.some((e) => e.includes('ocr_product_but_no_dom_context'))).toBe(true);
  });
});

describe('computeImageSlots — cross-region context', () => {
  it('regions=[article_body] guia adverts pra advertorial_image', () => {
    const $ = cheerio.load(`
      <html><body>
        <article>
          <img src="/inside.jpg" alt="Inside">
        </article>
      </body></html>
    `);
    const articleEl = $('article').get(0)!;
    const scope = buildDomScope($, articleEl);
    const regions: RegionEntry[] = [
      {
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
      },
    ];
    const r = computeImageSlots({
      html: '<html><body><article><img src="/inside.jpg" alt="Inside"></article></body></html>',
      regions,
    });
    expect(r.slots[0]!.slotKind).toBe('advertorial_image');
  });
});

describe('computeImageSlots — determinismo + zero mutation', () => {
  it('N=3 runs → identical JSON', () => {
    const runs = Array.from({ length: 3 }, () => computeImageSlots({ html: KACHING }));
    const first = JSON.stringify(runs[0]);
    for (let i = 1; i < 3; i++) expect(JSON.stringify(runs[i])).toBe(first);
  });

  it('input html não mutado', () => {
    const before = KACHING;
    computeImageSlots({ html: before });
    expect(before).toBe(KACHING);
  });
});

describe('computeImageSlots — count aggregation', () => {
  it('slotCountByKind e unknownCount preenchidos corretamente', () => {
    const html = `
      <html><body>
        <header><img src="/logo.png" alt="Brand Logo"></header>
        <img src="/unknown-1.jpg" alt="X">
        <img src="/decor.png" alt="" width="16" height="16">
      </body></html>
    `;
    const r = computeImageSlots({ html });
    expect(r.slotCountByKind.logo).toBe(1);
    expect(r.slotCountByKind.decorative).toBe(1);
    expect(r.slotCountByKind.unknown).toBe(1);
    expect(r.unknownCount).toBe(1);
  });
});

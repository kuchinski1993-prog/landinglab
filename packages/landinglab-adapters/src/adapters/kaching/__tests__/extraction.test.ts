import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { kachingAdapter } from '../index.js';
import { validateEditableFieldSource } from '../../../types/editable-field.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(
  __dirname,
  '../../../../../../apps/worker/src/__tests__/__fixtures__/render-golden',
);

function loadFixtureHtml(name: string): string {
  return readFileSync(join(FIXTURES_DIR, `${name}.input.html`), 'utf-8');
}

const KACHING = loadFixtureHtml('kaching-minimal');
const AURIVITA = loadFixtureHtml('aurivita-minimal');

describe('KachingAdapter.extract() — kaching-minimal fixture', () => {
  const result = kachingAdapter.extract({ html: KACHING });

  it('adapterId + family corretos', () => {
    expect(result.adapterId).toBe('kaching');
    expect(result.family).toBe('sales_page');
  });

  it('overallConfidence alto (>= 0.85)', () => {
    expect(result.overallConfidence).toBeGreaterThanOrEqual(0.85);
  });

  it('regions inclui APENAS bundles (closure 10.3: cta_primary+product_json fora do escopo Kaching)', () => {
    const kinds = result.regions.map((r) => r.kind);
    expect(kinds).toEqual(['bundles']);
  });

  it('bundles region critical + tem 3 children (cards)', () => {
    const bundles = result.regions.find((r) => r.kind === 'bundles')!;
    expect(bundles.criticality).toBe('critical');
    expect(bundles.selector).toBe('.kaching-bundles__bar[data-deal-bar-id]');
    expect(bundles.children).toHaveLength(3);
    expect(bundles.children!.every((c) => c.kind === 'price_block')).toBe(true);
  });

  it('bundle card selectors usam data-deal-bar-id (estável)', () => {
    const bundles = result.regions.find((r) => r.kind === 'bundles')!;
    const selectors = bundles.children!.map((c) => c.selector);
    expect(selectors).toEqual([
      '.kaching-bundles__bar[data-deal-bar-id="bar-1"]',
      '.kaching-bundles__bar[data-deal-bar-id="bar-2"]',
      '.kaching-bundles__bar[data-deal-bar-id="bar-3"]',
    ]);
  });

  it('legacy parity: bundleRegion.selector produz os mesmos N cards que detectBundleCardsLegacy', () => {
    const bundles = result.regions.find((r) => r.kind === 'bundles')!;
    const $ = cheerio.load(KACHING);
    const legacyCards = $('.kaching-bundles__bar[data-deal-bar-id]');
    const adapterCards = $(bundles.selector);
    expect(adapterCards.length).toBe(legacyCards.length);
    expect(adapterCards.length).toBe(3);
    // Ordem 1:1 conservada
    for (let i = 0; i < legacyCards.length; i++) {
      expect($(adapterCards[i]).attr('data-deal-bar-id')).toBe(
        $(legacyCards[i]).attr('data-deal-bar-id'),
      );
    }
  });

  it('editableFields: preço/compare de cada bundle apontam pra landing_bundle_offers (canonical)', () => {
    const priceFields = result.editableFields.filter(
      (f) => f.type === 'price' && f.id.includes('.price'),
    );
    const compareFields = result.editableFields.filter(
      (f) => f.type === 'price' && f.id.includes('.compare_at'),
    );

    expect(priceFields).toHaveLength(3);
    // Só bar-1 tem compare-at (fixture: bars 2 e 3 têm ambos, bar-1 tem ambos)
    // Fixture real tem $59.90 em cada bar → todos os 3 têm compare
    expect(compareFields).toHaveLength(3);

    for (const f of [...priceFields, ...compareFields]) {
      expect(f.source).toBe('canonical');
      expect(f.reference).toBeDefined();
      expect(f.reference!.table).toBe('landing_bundle_offers');
      expect(f.value).toBeUndefined();
      expect(f.criticality).toBe('critical');
    }
  });

  it('editableFields têm IDs estáveis (bundles.offer.N.*)', () => {
    const ids = result.editableFields.map((f) => f.id).sort();
    expect(ids).toEqual([
      'bundles.offer.0.compare_at',
      'bundles.offer.0.price',
      'bundles.offer.1.compare_at',
      'bundles.offer.1.price',
      'bundles.offer.2.compare_at',
      'bundles.offer.2.price',
    ]);
  });

  it('todos editableFields passam validateEditableFieldSource (A5)', () => {
    for (const f of result.editableFields) {
      expect(validateEditableFieldSource(f)).toEqual([]);
    }
  });

  it('zero warnings error-level em kaching-minimal', () => {
    expect(result.warnings.filter((w) => w.severity === 'error')).toEqual([]);
  });

  it('unclassified vazio (fixture não tem sticky ATC)', () => {
    expect(result.unclassified).toEqual([]);
  });
});

describe('KachingAdapter.extract() — html sem bundles', () => {
  it('HTML vazio → 0 regions bundles + warning missing_bundles_region', () => {
    const result = kachingAdapter.extract({ html: '<html><body></body></html>' });
    expect(result.regions.find((r) => r.kind === 'bundles')).toBeUndefined();
    expect(
      result.warnings.find((w) => w.code === 'missing_bundles_region'),
    ).toBeDefined();
  });
});

describe('KachingAdapter.extract() — critical region low confidence (D7)', () => {
  it('estrutura parcial (só 1 bar) → warning critical_region_low_confidence', () => {
    const html = `
      <html><body>
        <div class="kaching-bundles__bar" data-deal-bar-id="only-one"></div>
      </body></html>
    `;
    const result = kachingAdapter.extract({ html });
    // Score = R1(0.40) + R2(0.15) = 0.55 → abaixo de CRITICAL_MIN=0.60
    // Bundles region existe (bars > 0) mas warning error é emitido.
    const errWarn = result.warnings.find(
      (w) => w.code === 'critical_region_low_confidence',
    );
    expect(errWarn).toBeDefined();
    expect(errWarn?.severity).toBe('error');
    expect(errWarn?.region).toBe('bundles');
    expect(result.overallConfidence).toBeLessThan(0.6);
  });
});

describe('KachingAdapter.extract() — unclassified channel (§9)', () => {
  it('sticky ATC pattern → unclassified com reason', () => {
    const html = `
      <html><body>
        <div class="kaching-bundles__bar" data-deal-bar-id="a"><span class="kaching-bundles__bar-price">$1</span></div>
        <div class="kaching-bundles__bar" data-deal-bar-id="b"><span class="kaching-bundles__bar-price">$2</span></div>
        <div class="sticky-atc-bar">Buy now</div>
      </body></html>
    `;
    const result = kachingAdapter.extract({ html });
    expect(result.unclassified.length).toBeGreaterThanOrEqual(1);
    const u = result.unclassified[0];
    expect(u.reason).toMatch(/sticky|floating/i);
    expect(u.selector).toBe('.sticky-atc-bar');
  });
});

describe('KachingAdapter.extract() — aurivita fixture (theme errado)', () => {
  it('aurivita → sem bundles + warning missing_bundles_region', () => {
    const result = kachingAdapter.extract({ html: AURIVITA });
    expect(result.overallConfidence).toBeLessThan(0.3);
    expect(result.regions.find((r) => r.kind === 'bundles')).toBeUndefined();
    expect(
      result.warnings.find((w) => w.code === 'missing_bundles_region'),
    ).toBeDefined();
  });
});

describe('KachingAdapter.extract() — determinismo', () => {
  it('mesmo input → resultado semanticamente idêntico (JSON stringify)', () => {
    const a = kachingAdapter.extract({ html: KACHING });
    const b = kachingAdapter.extract({ html: KACHING });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('N=5 runs produzem overallConfidence idêntico', () => {
    const scores = Array.from(
      { length: 5 },
      () => kachingAdapter.extract({ html: KACHING }).overallConfidence,
    );
    expect(new Set(scores).size).toBe(1);
  });

  it('N=5 runs produzem lista de regions com mesmos IDs semânticos', () => {
    const runs = Array.from({ length: 5 }, () =>
      kachingAdapter.extract({ html: KACHING }),
    );
    const kindsSets = runs.map((r) => r.regions.map((x) => x.kind).sort().join(','));
    expect(new Set(kindsSets).size).toBe(1);
  });
});

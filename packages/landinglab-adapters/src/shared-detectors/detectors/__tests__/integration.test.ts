import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import {
  createSharedDetectorRegistry,
  runSharedDetectors,
} from '../../index.js';
import {
  accordionDetector,
  articleDetector,
  footerDetector,
  shopifyCtaDetector,
} from '../index.js';
import type { SharedDetectorContext, SharedRegionDetector } from '../../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAMILY_FIXTURES = join(
  __dirname,
  '../../../family-classifier/__tests__/__fixtures__',
);

const ADVERTORIAL = readFileSync(
  join(FAMILY_FIXTURES, 'advertorial-minimal.input.html'),
  'utf-8',
);
const PDP = readFileSync(join(FAMILY_FIXTURES, 'pdp-shopify-minimal.input.html'), 'utf-8');

function makeCtx(html: string, family: SharedDetectorContext['family']): SharedDetectorContext {
  return { html, $: cheerio.load(html), family, familyConfidence: 1.0 };
}

function buildRegistry() {
  const r = createSharedDetectorRegistry();
  r.register(shopifyCtaDetector);
  r.register(articleDetector);
  r.register(accordionDetector);
  r.register(footerDetector);
  r.freeze();
  return r;
}

describe('runSharedDetectors — advertorial integration', () => {
  it('advertorial → article claims + footer + zero CTA', () => {
    const registry = buildRegistry();
    const r = runSharedDetectors(makeCtx(ADVERTORIAL, 'advertorial'), registry);

    // Ordem determinística (accordion, article, footer, shopify-cta)
    expect(r.detectorRuns.map((d) => d.detectorId)).toEqual([
      'accordion',
      'article',
      'footer',
      'shopify-cta',
    ]);

    // Article claims
    const kinds = r.claims.map((c) => c.regionKind);
    expect(kinds).toContain('article_body');
    expect(kinds).toContain('headline');
    // Footer (fixture tem <footer>)
    expect(kinds).toContain('footer');
    // Zero CTA (advertorial não tem button[name="add"])
    expect(r.claims.filter((c) => c.regionKind === 'cta_primary')).toHaveLength(0);
    // Zero shadow error
    expect(r.warnings.filter((w) => w.code === 'shared_detector_error')).toHaveLength(0);
  });

  it('PDP → cta_primary + footer + zero article/faq', () => {
    const registry = buildRegistry();
    const r = runSharedDetectors(makeCtx(PDP, 'pdp_derived'), registry);

    const kinds = r.claims.map((c) => c.regionKind);
    expect(kinds).toContain('cta_primary');
    expect(kinds).toContain('footer');
    expect(kinds).not.toContain('article_body');
    expect(kinds).not.toContain('faq');
  });
});

describe('runSharedDetectors — failure isolation', () => {
  it('detector real works, synthetic throws, next real continues', () => {
    const bomb: SharedRegionDetector = {
      id: 'bomb',
      targetKinds: ['headline'] as const,
      supportedFamilies: [] as const,
      detect() {
        throw new Error('kaboom');
      },
    };

    const r = createSharedDetectorRegistry();
    r.register(shopifyCtaDetector);
    r.register(bomb);
    r.register(articleDetector);
    r.freeze();

    // Ordem alfabética: article, bomb, shopify-cta
    const result = runSharedDetectors(makeCtx(ADVERTORIAL, 'advertorial'), r);

    // Article rodou (rodou antes ou depois de bomb, irrelevante)
    expect(result.claims.some((c) => c.ownerId === 'article')).toBe(true);
    // Bomb error captured
    const bombRun = result.detectorRuns.find((d) => d.detectorId === 'bomb')!;
    expect(bombRun.errorMessage).toContain('kaboom');
    expect(result.warnings.some((w) => w.code === 'shared_detector_error')).toBe(true);
  });
});

describe('runSharedDetectors — determinismo cross-fixture', () => {
  const registry = buildRegistry();

  it('advertorial N=3 → JSON idêntico', () => {
    const runs = Array.from({ length: 3 }, () =>
      runSharedDetectors(makeCtx(ADVERTORIAL, 'advertorial'), registry),
    );
    // JSON.stringify pode ter ordens diferentes se sets/maps envolvidos.
    // Como retornamos arrays puros ordenados, deve ser byte-idêntico.
    const first = JSON.stringify(runs[0]);
    for (let i = 1; i < 3; i++) {
      expect(JSON.stringify(runs[i])).toBe(first);
    }
  });
});

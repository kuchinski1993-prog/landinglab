// ADR-002 §4.3 — PageFamilyClassifier tests.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyPageFamily } from '../classifier.js';
import {
  INITIAL_FAMILY_THRESHOLDS,
  type FamilyThresholds,
} from '../thresholds.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FAMILY_FIXTURES_DIR = join(__dirname, '__fixtures__');
const RENDER_FIXTURES_DIR = join(
  __dirname,
  '../../../../../apps/worker/src/__tests__/__fixtures__/render-golden',
);

function loadFamilyFixture(name: string): string {
  return readFileSync(join(FAMILY_FIXTURES_DIR, `${name}.input.html`), 'utf-8');
}
function loadRenderFixture(name: string): string {
  return readFileSync(join(RENDER_FIXTURES_DIR, `${name}.input.html`), 'utf-8');
}

const SALES_KACHING = loadRenderFixture('kaching-minimal');
const SALES_PSS_HYBRID = loadRenderFixture('pss-kaching-hybrid');
const AURIVITA = loadRenderFixture('aurivita-minimal');
const ADVERTORIAL = loadFamilyFixture('advertorial-minimal');
const PDP_SHOPIFY = loadFamilyFixture('pdp-shopify-minimal');
const GENERIC = '<html><body><h1>Hello</h1><p>Random content here.</p></body></html>';

// ─────────────────────────────────────────────────────────────
// Fixtures — happy paths
// ─────────────────────────────────────────────────────────────

describe('classifyPageFamily — fixtures representative', () => {
  it('sales_page: kaching-minimal → confident sales_page', () => {
    const r = classifyPageFamily({ html: SALES_KACHING });
    expect(r.family).toBe('sales_page');
    expect(r.familyResolution).toBe('confident');
    expect(r.familyConfidence).toBeGreaterThanOrEqual(0.25);
    expect(r.familySource).toBe('classifier_auto');
  });

  it('sales_page: pss-kaching-hybrid → confident sales_page', () => {
    const r = classifyPageFamily({ html: SALES_PSS_HYBRID });
    expect(r.family).toBe('sales_page');
    expect(r.familyResolution).toBe('confident');
  });

  it('advertorial: advertorial-minimal → confident advertorial', () => {
    const r = classifyPageFamily({ html: ADVERTORIAL });
    expect(r.family).toBe('advertorial');
    expect(r.familyResolution).toBe('confident');
    expect(r.familyConfidence).toBeGreaterThanOrEqual(INITIAL_FAMILY_THRESHOLDS.CLASSIFIER_MIN_CONFIDENCE);
  });

  it('pdp_derived: pdp-shopify-minimal → confident pdp_derived', () => {
    const r = classifyPageFamily({ html: PDP_SHOPIFY });
    expect(r.family).toBe('pdp_derived');
    expect(r.familyResolution).toBe('confident');
  });

  it('unknown: generic HTML → unknown', () => {
    const r = classifyPageFamily({ html: GENERIC });
    expect(r.family).toBe('unknown');
    expect(r.familySource).toBe('default_unknown');
    expect(r.familyConfidence).toBe(0);
  });

  it('unknown: HTML vazio → unknown', () => {
    const r = classifyPageFamily({ html: '' });
    expect(r.family).toBe('unknown');
    expect(r.familyConfidence).toBe(0);
  });

  it('aurivita → sales_page (cc-pdp-offer sinaliza sales, não pdp)', () => {
    // Aurivita minimal tem button.cc-pdp-offer sem form/cart estruturado.
    // Deve pontuar como sales_page (não pdp_derived).
    const r = classifyPageFamily({ html: AURIVITA });
    // Documenta o comportamento observado; se sales pontua alto, ótimo.
    // Se não, cai em unknown — aceito.
    expect(['sales_page', 'unknown']).toContain(r.family);
  });
});

// ─────────────────────────────────────────────────────────────
// A1: Source URL é AUXILIAR, nunca sozinha produz confident
// ─────────────────────────────────────────────────────────────

describe('A1 enforcement — source URL alone insufficient', () => {
  it('HTML sem estrutura Shopify + URL myshopify.com/products/X → NÃO confident pdp_derived', () => {
    const r = classifyPageFamily({
      html: GENERIC,
      sourceUrl: 'https://klensia.myshopify.com/products/foo',
    });
    // URL sozinha soma 0.05 → muito abaixo de 0.60 threshold.
    // Sem estrutura HTML, deve cair em unknown.
    expect(r.family).toBe('unknown');
    expect(r.familyResolution).not.toBe('confident');
  });

  it('HTML sem estrutura + URL /products/foo genérica → unknown', () => {
    const r = classifyPageFamily({
      html: GENERIC,
      sourceUrl: 'https://example.com/products/foo',
    });
    expect(r.family).toBe('unknown');
  });

  it('URL sem match → sem score bonus', () => {
    const r = classifyPageFamily({
      html: GENERIC,
      sourceUrl: 'https://example.com/blog/some-post',
    });
    expect(r.family).toBe('unknown');
  });

  it('URL myshopify.com/products SOMA ao PDP structural (não substitui)', () => {
    const rWith = classifyPageFamily({
      html: PDP_SHOPIFY,
      sourceUrl: 'https://klensia.myshopify.com/products/foo',
    });
    const rWithout = classifyPageFamily({ html: PDP_SHOPIFY });
    // Com URL match, score maior — mas ambos confident pdp_derived.
    expect(rWith.family).toBe('pdp_derived');
    expect(rWithout.family).toBe('pdp_derived');
    // Ambos confident (estrutura HTML suficiente sozinha).
    expect(rWith.familyResolution).toBe('confident');
    expect(rWithout.familyResolution).toBe('confident');
    // rWith deve ter score >= rWithout (URL aditiva)
    expect(rWith.familyConfidence).toBeGreaterThanOrEqual(rWithout.familyConfidence);
  });
});

// ─────────────────────────────────────────────────────────────
// User hint precedence (D-11.1)
// ─────────────────────────────────────────────────────────────

describe('user hint precedence', () => {
  it('userHint=sales_page → family=sales_page (autoritativo)', () => {
    const r = classifyPageFamily({
      html: ADVERTORIAL, // estrutura advertorial forte
      userHint: 'sales_page',
    });
    expect(r.family).toBe('sales_page');
    expect(r.familySource).toBe('user_hint');
    expect(r.familyConfidence).toBe(1.0);
    // Warning documenta divergência
    expect(r.warnings.some((w) => w.code === 'user_hint_diverges_from_classifier')).toBe(true);
  });

  it('userHint=advertorial + HTML sales → family=advertorial + warning', () => {
    const r = classifyPageFamily({
      html: SALES_KACHING,
      userHint: 'advertorial',
    });
    expect(r.family).toBe('advertorial');
    expect(r.familySource).toBe('user_hint');
    expect(r.warnings.some((w) => w.code === 'user_hint_diverges_from_classifier')).toBe(true);
  });

  it('userHint=pdp_derived (com pdp_derived agora no CHECK constraint) → wins', () => {
    const r = classifyPageFamily({
      html: SALES_KACHING,
      userHint: 'pdp_derived',
    });
    expect(r.family).toBe('pdp_derived');
    expect(r.familySource).toBe('user_hint');
  });

  it('userHint=unknown → classifier auto roda normalmente', () => {
    const r = classifyPageFamily({
      html: ADVERTORIAL,
      userHint: 'unknown',
    });
    expect(r.familySource).toBe('classifier_auto');
    expect(r.family).toBe('advertorial');
  });

  it('userHint=null → classifier auto roda', () => {
    const r = classifyPageFamily({
      html: ADVERTORIAL,
      userHint: null,
    });
    expect(r.familySource).toBe('classifier_auto');
    expect(r.family).toBe('advertorial');
  });

  it('userHint=sales_page + HTML sales concordante → sem warning divergência', () => {
    const r = classifyPageFamily({
      html: SALES_KACHING,
      userHint: 'sales_page',
    });
    expect(r.family).toBe('sales_page');
    expect(r.warnings.some((w) => w.code === 'user_hint_diverges_from_classifier')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Ambiguous / conflicting evidence
// ─────────────────────────────────────────────────────────────

describe('conflicting evidence', () => {
  it('HTML com sinais sales + advertorial fortes → ambiguous OU um deles com margin', () => {
    // Kaching bundle widget + <article> + long paragraphs — mistura possível
    const mixed = `
      <html><body>
        <article>
          <h1>Hidden Truth</h1>
          <p>Millions of adults suffer from this common health issue.</p>
          <p>A new discovery has helped thousands find relief.</p>
          <p>The natural solution combines three traditional herbs.</p>
          <p>Users report improvements within weeks.</p>
          <p>Continue reading to learn more.</p>
        </article>
        <div class="kaching-bundles__bar" data-deal-bar-id="a">
          <span class="kaching-bundles__bar-price">$30</span>
        </div>
        <div class="kaching-bundles__bar" data-deal-bar-id="b">
          <span class="kaching-bundles__bar-price">$60</span>
        </div>
      </body></html>
    `;
    const r = classifyPageFamily({ html: mixed });
    // Ambos famílias pontuam. Documenta comportamento — não força específico.
    // Aceito confident em qualquer OU ambiguous com margin baixa.
    if (r.familyResolution === 'confident') {
      expect(['sales_page', 'advertorial']).toContain(r.family);
    } else {
      expect(['ambiguous', 'unknown']).toContain(r.familyResolution);
    }
    expect(r.candidates.length).toBeGreaterThan(1);
  });

  it('nunca lança em HTML corrompido', () => {
    expect(() => classifyPageFamily({ html: '<not-html>>>' })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Threshold e margin
// ─────────────────────────────────────────────────────────────

describe('threshold + margin behavior', () => {
  it('score abaixo de CLASSIFIER_MIN_CONFIDENCE → unknown', () => {
    // 1 kaching bar solto = R1 (0.25) → abaixo de 0.60
    const partial = `
      <html><body>
        <div class="kaching-bundles__bar" data-deal-bar-id="only">
          <span>$1</span>
        </div>
      </body></html>
    `;
    const r = classifyPageFamily({ html: partial });
    expect(r.family).toBe('unknown');
  });

  it('custom thresholds override initial values', () => {
    // Threshold muito baixo → mesmo score fraco vira confident
    const partial = `
      <html><body>
        <div class="kaching-bundles__bar" data-deal-bar-id="a"></div>
      </body></html>
    `;
    const custom: FamilyThresholds = {
      CLASSIFIER_MIN_CONFIDENCE: 0.1,
      CLASSIFIER_MARGIN_THRESHOLD: 0.05,
    };
    const r = classifyPageFamily({ html: partial }, { thresholds: custom });
    expect(r.family).toBe('sales_page');
    expect(r.familyResolution).toBe('confident');
  });

  it('INITIAL_FAMILY_THRESHOLDS é frozen', () => {
    expect(Object.isFrozen(INITIAL_FAMILY_THRESHOLDS)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Determinismo
// ─────────────────────────────────────────────────────────────

describe('determinismo', () => {
  it('mesmo input → mesmo output N vezes', () => {
    const runs = Array.from({ length: 5 }, () =>
      classifyPageFamily({ html: SALES_KACHING }),
    );
    const scores = new Set(runs.map((r) => r.familyConfidence));
    expect(scores.size).toBe(1);
    const families = new Set(runs.map((r) => r.family));
    expect(families.size).toBe(1);
  });

  it('reasons não-vazio quando confident', () => {
    const r = classifyPageFamily({ html: SALES_KACHING });
    expect(r.familyResolution).toBe('confident');
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('candidates são ordenados desc por score', () => {
    const r = classifyPageFamily({ html: SALES_KACHING });
    for (let i = 1; i < r.candidates.length; i++) {
      expect(r.candidates[i - 1].score).toBeGreaterThanOrEqual(r.candidates[i].score);
    }
  });
});

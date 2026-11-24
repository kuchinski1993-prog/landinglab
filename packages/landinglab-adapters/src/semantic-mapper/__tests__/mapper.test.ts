import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computePageSemanticModel } from '../mapper.js';
import { createAdapterRegistry } from '../../registry.js';
import { kachingAdapter } from '../../adapters/kaching/index.js';
import { createSharedDetectorRegistry } from '../../shared-detectors/registry.js';
import {
  accordionDetector,
  articleDetector,
  footerDetector,
  shopifyCtaDetector,
} from '../../shared-detectors/detectors/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDER_FIXTURES = join(
  __dirname,
  '../../../../../apps/worker/src/__tests__/__fixtures__/render-golden',
);
const FAMILY_FIXTURES = join(
  __dirname,
  '../../family-classifier/__tests__/__fixtures__',
);

const KACHING = readFileSync(join(RENDER_FIXTURES, 'kaching-minimal.input.html'), 'utf-8');
const PSS_HYBRID = readFileSync(join(RENDER_FIXTURES, 'pss-kaching-hybrid.input.html'), 'utf-8');
const AURIVITA = readFileSync(join(RENDER_FIXTURES, 'aurivita-minimal.input.html'), 'utf-8');
const ADVERTORIAL = readFileSync(join(FAMILY_FIXTURES, 'advertorial-minimal.input.html'), 'utf-8');
const PDP = readFileSync(join(FAMILY_FIXTURES, 'pdp-shopify-minimal.input.html'), 'utf-8');

function buildRegistries() {
  const adapterRegistry = createAdapterRegistry();
  adapterRegistry.register(kachingAdapter);
  adapterRegistry.freeze();

  const sharedRegistry = createSharedDetectorRegistry();
  sharedRegistry.register(shopifyCtaDetector);
  sharedRegistry.register(articleDetector);
  sharedRegistry.register(accordionDetector);
  sharedRegistry.register(footerDetector);
  sharedRegistry.freeze();

  return { adapterRegistry, sharedRegistry };
}

// ─────────────────────────────────────────────────────────────

describe('computePageSemanticModel — kaching-minimal', () => {
  const { adapterRegistry, sharedRegistry } = buildRegistries();

  it('produces model with family=sales_page + Kaching component + bundles region', () => {
    const model = computePageSemanticModel({
      html: KACHING,
      landingPageId: 'test-kaching',
      adapterRegistry,
      sharedRegistry,
    });

    expect(model.family).toBe('sales_page');
    expect(model.familySource).toBe('classifier_auto');
    expect(model.familyConfidence).toBeGreaterThanOrEqual(0.6);
    expect(model.components).toHaveLength(1);
    expect(model.components[0]!.componentId).toBe('kaching');
    const bundles = model.regions.find((r) => r.kind === 'bundles');
    expect(bundles).toBeDefined();
    expect(bundles!.source).toBe('component_adapter');
    expect(model.criticalRegionsHealthy).toBe(true);
  });
});

describe('computePageSemanticModel — pss-kaching-hybrid', () => {
  const { adapterRegistry, sharedRegistry } = buildRegistries();

  it('reconhece bundles Kaching + tenta detectar cta/footer via shared', () => {
    const model = computePageSemanticModel({
      html: PSS_HYBRID,
      adapterRegistry,
      sharedRegistry,
    });
    expect(model.family).toBe('sales_page');
    expect(model.components).toHaveLength(1);
    const kinds = model.regions.map((r) => r.kind);
    expect(kinds).toContain('bundles');
  });
});

describe('computePageSemanticModel — advertorial-minimal', () => {
  const { adapterRegistry, sharedRegistry } = buildRegistries();

  it('produces family=advertorial + article regions + footer', () => {
    const model = computePageSemanticModel({
      html: ADVERTORIAL,
      adapterRegistry,
      sharedRegistry,
    });
    expect(model.family).toBe('advertorial');
    // Article body + headline emitidos
    const kinds = model.regions.map((r) => r.kind);
    expect(kinds).toContain('article_body');
    expect(kinds).toContain('headline');
    expect(kinds).toContain('footer');
    // Zero Kaching component
    expect(model.components).toHaveLength(0);
  });
});

describe('computePageSemanticModel — pdp-shopify-minimal', () => {
  const { adapterRegistry, sharedRegistry } = buildRegistries();

  it('produces family=pdp_derived + cta_primary + footer', () => {
    const model = computePageSemanticModel({
      html: PDP,
      adapterRegistry,
      sharedRegistry,
    });
    expect(model.family).toBe('pdp_derived');
    const kinds = model.regions.map((r) => r.kind);
    expect(kinds).toContain('cta_primary');
    expect(kinds).toContain('footer');
  });
});

describe('computePageSemanticModel — aurivita-minimal', () => {
  const { adapterRegistry, sharedRegistry } = buildRegistries();

  it('no Kaching component, no article, no CTA shopify → minimal model', () => {
    const model = computePageSemanticModel({
      html: AURIVITA,
      adapterRegistry,
      sharedRegistry,
    });
    // Zero Kaching component (Aurivita usa cc-pdp-offer, não kaching)
    expect(model.components).toHaveLength(0);
    // Zero article/faq/cta
    const kinds = model.regions.map((r) => r.kind);
    expect(kinds).not.toContain('article_body');
    expect(kinds).not.toContain('cta_primary');
    expect(kinds).not.toContain('faq');
  });
});

// ─────────────────────────────────────────────────────────────
// User hint precedence
// ─────────────────────────────────────────────────────────────

describe('computePageSemanticModel — user hint', () => {
  const { adapterRegistry, sharedRegistry } = buildRegistries();

  it('userHint=sales_page override classifier', () => {
    const model = computePageSemanticModel({
      html: ADVERTORIAL,
      userHint: 'sales_page',
      adapterRegistry,
      sharedRegistry,
    });
    expect(model.family).toBe('sales_page');
    expect(model.familySource).toBe('user_hint');
  });
});

// ─────────────────────────────────────────────────────────────
// Zero mutation
// ─────────────────────────────────────────────────────────────

describe('computePageSemanticModel — zero mutation', () => {
  const { adapterRegistry, sharedRegistry } = buildRegistries();

  it('input html string não é modificado', () => {
    const before = KACHING;
    computePageSemanticModel({
      html: before,
      adapterRegistry,
      sharedRegistry,
    });
    expect(before).toBe(KACHING); // Primitive is immutable, sanity check
  });
});

// ─────────────────────────────────────────────────────────────
// Determinism
// ─────────────────────────────────────────────────────────────

describe('computePageSemanticModel — determinism', () => {
  const { adapterRegistry, sharedRegistry } = buildRegistries();

  it('N=3 execuções produzem model semanticamente idêntico (ignora computedAt)', () => {
    const runs = Array.from({ length: 3 }, () =>
      computePageSemanticModel({
        html: KACHING,
        computedAt: 'fixed',
        adapterRegistry,
        sharedRegistry,
      }),
    );
    const first = JSON.stringify(runs[0]);
    for (let i = 1; i < 3; i++) {
      expect(JSON.stringify(runs[i])).toBe(first);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Never throws
// ─────────────────────────────────────────────────────────────

describe('computePageSemanticModel — never throws', () => {
  const { adapterRegistry, sharedRegistry } = buildRegistries();

  it('HTML vazio → model minimal, sem throw', () => {
    expect(() =>
      computePageSemanticModel({ html: '', adapterRegistry, sharedRegistry }),
    ).not.toThrow();
    const model = computePageSemanticModel({
      html: '',
      adapterRegistry,
      sharedRegistry,
    });
    expect(model.family).toBe('unknown');
  });

  it('HTML corrompido → model minimal', () => {
    expect(() =>
      computePageSemanticModel({
        html: '<broken>>>',
        adapterRegistry,
        sharedRegistry,
      }),
    ).not.toThrow();
  });

  it('sem registries → model apenas com family', () => {
    const model = computePageSemanticModel({ html: KACHING });
    expect(model.family).toBe('sales_page');
    expect(model.regions).toHaveLength(0);
    expect(model.components).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Overall confidence + critical health
// ─────────────────────────────────────────────────────────────

describe('computePageSemanticModel — confidence', () => {
  const { adapterRegistry, sharedRegistry } = buildRegistries();

  it('kaching → overallConfidence > 0 + criticalRegionsHealthy', () => {
    const model = computePageSemanticModel({
      html: KACHING,
      adapterRegistry,
      sharedRegistry,
    });
    expect(model.overallConfidence).toBeGreaterThan(0);
    expect(model.criticalRegionsHealthy).toBe(true);
  });

  it('generic HTML → overallConfidence=0 + healthy trivially true (0 regiões críticas)', () => {
    const model = computePageSemanticModel({
      html: '<html><body><p>x</p></body></html>',
      adapterRegistry,
      sharedRegistry,
    });
    expect(model.overallConfidence).toBe(0);
    // Sem regiões críticas → healthy=true por vacuidade
    expect(model.criticalRegionsHealthy).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Meta info
// ─────────────────────────────────────────────────────────────

describe('computePageSemanticModel — meta info', () => {
  const { adapterRegistry, sharedRegistry } = buildRegistries();

  it('meta.detectorsRun + adaptersConsulted preenchidos', () => {
    const model = computePageSemanticModel({
      html: KACHING,
      adapterRegistry,
      sharedRegistry,
    });
    expect(model.meta.adaptersConsulted).toBe(1); // Kaching
    expect(model.meta.detectorsRun).toBeGreaterThanOrEqual(1);
  });
});

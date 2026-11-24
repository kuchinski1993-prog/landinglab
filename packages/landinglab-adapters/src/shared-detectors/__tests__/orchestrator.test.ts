import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
  buildDomScope,
  createSharedDetectorRegistry,
  runSharedDetectors,
  type SharedDetectorContext,
  type SharedRegionDetector,
  type RegionOwnershipClaim,
} from '../index.js';
import { criticalityOf } from '../../types/semantic-region.js';
import type { PageFamily } from '../../types/page-family.js';

function makeCtx(html: string, family: PageFamily = 'sales_page'): SharedDetectorContext {
  return {
    html,
    $: cheerio.load(html),
    family,
    familyConfidence: 1.0,
  };
}

function makeSampleClaim(
  detectorId: string,
  ctx: SharedDetectorContext,
): RegionOwnershipClaim {
  const el = ctx.$('h1').get(0);
  const scope = el
    ? buildDomScope(ctx.$, el)
    : buildDomScope(ctx.$, ctx.$('body').get(0)!);
  return {
    ownerId: detectorId,
    originType: 'shared_detector',
    regionKind: 'headline',
    scope,
    priority: 40,
    confidence: 0.9,
    authoritative: false,
    reason: 'test',
    region: {
      kind: 'headline',
      selector: scope.selector,
      evidence: { reasons: ['test'], matchedRules: ['test'] },
      confidence: 0.9,
      criticality: criticalityOf('headline'),
    },
  };
}

function makeDetector(
  id: string,
  opts: {
    emit?: number;
    throws?: boolean;
    families?: PageFamily[];
  } = {},
): SharedRegionDetector {
  return {
    id,
    targetKinds: ['headline'],
    supportedFamilies: opts.families ?? [],
    detect(ctx) {
      if (opts.throws) throw new Error(`boom from ${id}`);
      const claims: RegionOwnershipClaim[] = [];
      const count = opts.emit ?? 0;
      for (let i = 0; i < count; i++) {
        claims.push(makeSampleClaim(id, ctx));
      }
      return {
        detectorId: id,
        ownershipClaims: claims,
        editableFields: [],
        unclassified: [],
        warnings: [],
        reasons: [`${id}: emitted ${count}`],
      };
    },
  };
}

const HTML = '<html><body><h1>T</h1></body></html>';

// ─────────────────────────────────────────────────────────────

describe('runSharedDetectors — execution', () => {
  it('zero detectors → aggregate vazio', () => {
    const registry = createSharedDetectorRegistry();
    registry.freeze();
    const r = runSharedDetectors(makeCtx(HTML), registry);
    expect(r.claims).toEqual([]);
    expect(r.detectorRuns).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('one detector → run + claim agregado', () => {
    const registry = createSharedDetectorRegistry();
    registry.register(makeDetector('one', { emit: 1 }));
    registry.freeze();
    const r = runSharedDetectors(makeCtx(HTML), registry);
    expect(r.claims).toHaveLength(1);
    expect(r.detectorRuns).toHaveLength(1);
    expect(r.detectorRuns[0]!.ran).toBe(true);
    expect(r.detectorRuns[0]!.claimCount).toBe(1);
  });

  it('multiple detectors → todos rodam, ordem determinística por detector.id asc', () => {
    const registry = createSharedDetectorRegistry();
    registry.register(makeDetector('zebra', { emit: 1 }));
    registry.register(makeDetector('alpha', { emit: 2 }));
    registry.register(makeDetector('mango', { emit: 1 }));
    registry.freeze();

    const r = runSharedDetectors(makeCtx(HTML), registry);
    expect(r.detectorRuns.map((d) => d.detectorId)).toEqual(['alpha', 'mango', 'zebra']);
    expect(r.claims).toHaveLength(4);
    // claims aparecem na ordem: alpha (2) + mango (1) + zebra (1)
    expect(r.claims[0]!.ownerId).toBe('alpha');
    expect(r.claims[1]!.ownerId).toBe('alpha');
    expect(r.claims[2]!.ownerId).toBe('mango');
    expect(r.claims[3]!.ownerId).toBe('zebra');
  });

  it('detector throws → captured, outros continuam', () => {
    const registry = createSharedDetectorRegistry();
    registry.register(makeDetector('alpha', { emit: 1 }));
    registry.register(makeDetector('broken', { throws: true }));
    registry.register(makeDetector('zebra', { emit: 1 }));
    registry.freeze();

    const r = runSharedDetectors(makeCtx(HTML), registry);
    expect(r.claims).toHaveLength(2); // alpha + zebra
    const brokenRun = r.detectorRuns.find((d) => d.detectorId === 'broken')!;
    expect(brokenRun.errorMessage).toContain('boom from broken');
    expect(r.warnings.some((w) => w.code === 'shared_detector_error')).toBe(true);
  });

  it('deterministic across N runs', () => {
    const registry = createSharedDetectorRegistry();
    registry.register(makeDetector('a', { emit: 2 }));
    registry.register(makeDetector('b', { emit: 1 }));
    registry.freeze();

    const runs = Array.from({ length: 5 }, () => runSharedDetectors(makeCtx(HTML), registry));
    const first = JSON.stringify(runs[0]);
    for (let i = 1; i < runs.length; i++) {
      expect(JSON.stringify(runs[i])).toBe(first);
    }
  });

  it('family mismatch → skip com skippedReason', () => {
    const registry = createSharedDetectorRegistry();
    registry.register(makeDetector('advertorial-only', { emit: 1, families: ['advertorial'] }));
    registry.register(makeDetector('always', { emit: 1, families: [] }));
    registry.freeze();

    // ctx.family = sales_page → advertorial-only pula
    const r = runSharedDetectors(makeCtx(HTML, 'sales_page'), registry);
    const advRun = r.detectorRuns.find((d) => d.detectorId === 'advertorial-only')!;
    expect(advRun.ran).toBe(false);
    expect(advRun.skippedReason).toBe('family_mismatch');
    // apenas 'always' rodou → 1 claim
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]!.ownerId).toBe('always');
  });

  it('family=[] equivale a "todas" → detector roda', () => {
    const registry = createSharedDetectorRegistry();
    registry.register(makeDetector('all-family', { emit: 1, families: [] }));
    registry.freeze();

    for (const family of ['sales_page', 'advertorial', 'pdp_derived', 'unknown'] as PageFamily[]) {
      const r = runSharedDetectors(makeCtx(HTML, family), registry);
      const run = r.detectorRuns[0]!;
      expect(run.ran).toBe(true);
    }
  });

  it('unhandled runtime error nunca escapa pro caller', () => {
    const registry = createSharedDetectorRegistry();
    registry.register(makeDetector('bomba', { throws: true }));
    registry.freeze();
    expect(() => runSharedDetectors(makeCtx(HTML), registry)).not.toThrow();
  });
});

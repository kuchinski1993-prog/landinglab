import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
  buildDomScope,
  DEFAULT_PRIORITY_BY_ORIGIN,
  isOriginAllowedForKind,
  KIND_OWNERSHIP_DEFAULTS,
  resolveOwnership,
  type DomScope,
  type OriginType,
  type RegionOwnershipClaim,
} from '../index.js';
import type { SemanticRegion, SemanticRegionKind } from '../../types/semantic-region.js';
import { criticalityOf } from '../../types/semantic-region.js';

function makeRegion(
  kind: SemanticRegionKind,
  selector: string,
  confidence: number,
): SemanticRegion {
  return {
    kind,
    selector,
    evidence: { reasons: ['test'], matchedRules: ['test'] },
    confidence,
    criticality: criticalityOf(kind),
  };
}

function makeClaim(
  ownerId: string,
  originType: OriginType,
  regionKind: SemanticRegionKind,
  scope: DomScope,
  confidence = 0.8,
  authoritative = false,
  priority?: number,
): RegionOwnershipClaim {
  return {
    ownerId,
    originType,
    regionKind,
    scope,
    priority: priority ?? DEFAULT_PRIORITY_BY_ORIGIN[originType],
    confidence,
    authoritative,
    reason: `test claim ${ownerId}`,
    region: makeRegion(regionKind, scope.selector, confidence),
  };
}

const HTML = `
<html><body>
  <div class="hero">
    <h1 class="title">Big</h1>
    <p class="tag">Subtitle</p>
  </div>
  <button name="add" class="add-cta">Add</button>
  <div class="sticky-atc">
    <button name="add">Sticky Add</button>
  </div>
  <div class="kaching-bundles__bar" data-deal-bar-id="a"></div>
</body></html>
`;

const $ = cheerio.load(HTML);
const heroScope = buildDomScope($, $('.hero').get(0)!);
const titleScope = buildDomScope($, $('.title').get(0)!);
const mainCtaScope = buildDomScope($, $('.add-cta').get(0)!);
const stickyCtaScope = buildDomScope($, $('.sticky-atc button').get(0)!);
const bundleScope = buildDomScope($, $('.kaching-bundles__bar').get(0)!);

// ─────────────────────────────────────────────────────────────
// KIND_OWNERSHIP_DEFAULTS sanity
// ─────────────────────────────────────────────────────────────

describe('KIND_OWNERSHIP_DEFAULTS', () => {
  it('bundles: component_adapter é primary', () => {
    expect(KIND_OWNERSHIP_DEFAULTS.bundles[0]).toBe('component_adapter');
  });

  it('cta_primary: shared_detector é primary', () => {
    expect(KIND_OWNERSHIP_DEFAULTS.cta_primary[0]).toBe('shared_detector');
  });

  it('headline: shared_detector é primary; component NÃO é permitido', () => {
    expect(KIND_OWNERSHIP_DEFAULTS.headline[0]).toBe('shared_detector');
    expect(KIND_OWNERSHIP_DEFAULTS.headline.includes('component_adapter')).toBe(false);
  });

  it('article_body: shared_detector é primary; component NÃO permitido', () => {
    expect(KIND_OWNERSHIP_DEFAULTS.article_body[0]).toBe('shared_detector');
    expect(KIND_OWNERSHIP_DEFAULTS.article_body.includes('component_adapter')).toBe(false);
  });

  it('isOriginAllowedForKind reflete a tabela', () => {
    expect(isOriginAllowedForKind('component_adapter', 'bundles')).toBe(true);
    expect(isOriginAllowedForKind('component_adapter', 'headline')).toBe(false);
    expect(isOriginAllowedForKind('shared_detector', 'cta_primary')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Same kind + same scope → resolution
// ─────────────────────────────────────────────────────────────

describe('resolveOwnership — same kind + same scope', () => {
  it('component_adapter authoritative wins em bundles', () => {
    const kachingClaim = makeClaim(
      'kaching',
      'component_adapter',
      'bundles',
      bundleScope,
      1.0,
      true, // authoritative
    );
    const sharedClaim = makeClaim(
      'shared-bundles-detector',
      'shared_detector',
      'bundles',
      bundleScope,
      0.7,
    );

    const { winners, conflicts } = resolveOwnership([kachingClaim, sharedClaim]);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.ownerId).toBe('kaching');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.resolution).toBe('resolved');
    expect(conflicts[0]!.losers).toHaveLength(1);
    expect(conflicts[0]!.losers[0]!.claim.ownerId).toBe('shared-bundles-detector');
  });

  it('shared_detector é primary em headline; component NÃO steal', () => {
    const componentClaim = makeClaim(
      'kaching',
      'component_adapter',
      'headline', // kind não permitido pra component
      titleScope,
      1.0,
      true, // tenta authoritative
    );
    const sharedClaim = makeClaim(
      'shared-headline',
      'shared_detector',
      'headline',
      titleScope,
      0.85,
    );

    const { winners, conflicts } = resolveOwnership([componentClaim, sharedClaim]);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.ownerId).toBe('shared-headline'); // NÃO Kaching
    expect(conflicts).toHaveLength(1);
    // Component foi denied porque authoritative fora do kind default
    expect(
      conflicts[0]!.losers.some(
        (l) => l.claim.ownerId === 'kaching' && l.reason === 'authoritative_denied',
      ),
    ).toBe(true);
  });

  it('empate real → ambiguous (11.2 CLOSURE: NENHUM authoritative winner)', () => {
    const a = makeClaim('detector-a', 'shared_detector', 'headline', titleScope, 0.9);
    const b = makeClaim('detector-b', 'shared_detector', 'headline', titleScope, 0.9);
    const { winners, conflicts } = resolveOwnership([a, b]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.resolution).toBe('ambiguous');
    expect(conflicts[0]!.warning?.code).toBe('ambiguous_ownership');
    // CLOSURE: winner deve ser undefined, winnerIsAuthoritative=false
    expect(conflicts[0]!.winner).toBeUndefined();
    expect(conflicts[0]!.winnerIsAuthoritative).toBe(false);
    // deterministicCandidate presente APENAS pra logs/diagnóstico
    expect(conflicts[0]!.deterministicCandidate).toBeDefined();
    expect(conflicts[0]!.deterministicCandidate?.ownerId).toBe('detector-a');
    // winners[] NÃO inclui nenhum claim ambíguo
    expect(winners).toHaveLength(0);
  });

  it('confidence maior wins sem authoritative', () => {
    const low = makeClaim('shared-low', 'shared_detector', 'headline', titleScope, 0.6);
    const high = makeClaim('shared-high', 'shared_detector', 'headline', titleScope, 0.9);
    const { winners, conflicts } = resolveOwnership([low, high]);
    expect(winners[0]!.ownerId).toBe('shared-high');
    expect(conflicts[0]!.resolution).toBe('resolved');
    expect(
      conflicts[0]!.losers.find((l) => l.claim.ownerId === 'shared-low')!.reason,
    ).toBe('lower_confidence');
  });
});

// ─────────────────────────────────────────────────────────────
// Same kind + different scopes → coexist (não conflito)
// ─────────────────────────────────────────────────────────────

describe('resolveOwnership — same kind + different scopes', () => {
  it('dois cta_primary em scopes distintos → ambos winners, zero conflict', () => {
    const main = makeClaim('shared-cta', 'shared_detector', 'cta_primary', mainCtaScope, 0.9);
    const sticky = makeClaim(
      'shared-cta-sticky',
      'shared_detector',
      'cta_primary',
      stickyCtaScope,
      0.7,
    );
    const { winners, conflicts } = resolveOwnership([main, sticky]);
    expect(winners).toHaveLength(2);
    expect(conflicts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Different kinds nested scopes → coexist
// ─────────────────────────────────────────────────────────────

describe('resolveOwnership — different kinds nested', () => {
  it('hero (container) + headline (child) coexistem sem conflict', () => {
    const hero = makeClaim('shared-hero', 'shared_detector', 'hero', heroScope, 0.8);
    const headline = makeClaim(
      'shared-headline',
      'shared_detector',
      'headline',
      titleScope,
      0.9,
    );
    const { winners, conflicts } = resolveOwnership([hero, headline]);
    expect(winners).toHaveLength(2);
    // Kinds diferentes → NÃO agrupados pelo resolver atual
    expect(conflicts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Higher confidence sozinho NÃO override ownership incompatível
// ─────────────────────────────────────────────────────────────

describe('confidence alta sozinha não subverte ownership', () => {
  it('component_adapter com confidence=1.0 authoritative em article_body → NÃO ganha', () => {
    // article_body NÃO permite component_adapter
    const componentClaim = makeClaim(
      'some-component',
      'component_adapter',
      'article_body',
      titleScope,
      1.0,
      true,
    );
    const sharedClaim = makeClaim(
      'shared-article',
      'shared_detector',
      'article_body',
      titleScope,
      0.6,
    );
    const { winners } = resolveOwnership([componentClaim, sharedClaim]);
    expect(winners[0]!.ownerId).toBe('shared-article');
  });
});

// ─────────────────────────────────────────────────────────────
// True tie → ambiguous, no silent winner
// ─────────────────────────────────────────────────────────────

describe('tie handling', () => {
  it('mesma origem + mesma confidence + mesma priority → ambiguous warning', () => {
    const a = makeClaim(
      'detector-a',
      'shared_detector',
      'cta_primary',
      mainCtaScope,
      0.8,
      false,
      50,
    );
    const b = makeClaim(
      'detector-b',
      'shared_detector',
      'cta_primary',
      mainCtaScope,
      0.8,
      false,
      50,
    );
    const { conflicts } = resolveOwnership([a, b]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.resolution).toBe('ambiguous');
    expect(conflicts[0]!.warning).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Empty
// ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('array vazio → winners e conflicts vazios', () => {
    const { winners, conflicts } = resolveOwnership([]);
    expect(winners).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it('claim único → winner sem conflict', () => {
    const c = makeClaim('a', 'shared_detector', 'headline', titleScope);
    const { winners, conflicts } = resolveOwnership([c]);
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
  });
});

// 11.2 CLOSURE — winnerIsAuthoritative discipline
describe('winnerIsAuthoritative discipline (11.2 CLOSURE)', () => {
  it('resolved → winnerIsAuthoritative=true + winner definido', () => {
    const kachingClaim = makeClaim(
      'kaching',
      'component_adapter',
      'bundles',
      bundleScope,
      1.0,
      true,
    );
    const sharedClaim = makeClaim(
      'shared-bundles',
      'shared_detector',
      'bundles',
      bundleScope,
      0.7,
    );
    const { conflicts } = resolveOwnership([kachingClaim, sharedClaim]);
    expect(conflicts[0]!.resolution).toBe('resolved');
    expect(conflicts[0]!.winnerIsAuthoritative).toBe(true);
    expect(conflicts[0]!.winner).toBeDefined();
    expect(conflicts[0]!.deterministicCandidate).toBeUndefined();
  });

  it('ambiguous → winnerIsAuthoritative=false + winner=undefined + deterministicCandidate presente', () => {
    const a = makeClaim('a', 'shared_detector', 'headline', titleScope, 0.9);
    const b = makeClaim('b', 'shared_detector', 'headline', titleScope, 0.9);
    const { winners, conflicts } = resolveOwnership([a, b]);
    expect(conflicts[0]!.resolution).toBe('ambiguous');
    expect(conflicts[0]!.winnerIsAuthoritative).toBe(false);
    expect(conflicts[0]!.winner).toBeUndefined();
    expect(conflicts[0]!.deterministicCandidate).toBeDefined();
    expect(winners).toEqual([]);
  });

  it('conflicting (todos denied) → winnerIsAuthoritative=false, winner=undefined', () => {
    // Ambos component_adapter authoritative em article_body (não permitido)
    const a = makeClaim('a', 'component_adapter', 'article_body', titleScope, 1.0, true);
    const b = makeClaim('b', 'component_adapter', 'article_body', titleScope, 0.9, true);
    const { winners, conflicts } = resolveOwnership([a, b]);
    expect(conflicts[0]!.resolution).toBe('conflicting');
    expect(conflicts[0]!.winnerIsAuthoritative).toBe(false);
    expect(conflicts[0]!.winner).toBeUndefined();
    expect(winners).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { isPageFamily, PAGE_FAMILIES } from '../types/page-family.js';
import {
  criticalityOf,
  CRITICAL_REGION_KINDS,
  NON_CRITICAL_REGION_KINDS,
  SEMANTIC_REGION_KINDS,
} from '../types/semantic-region.js';

describe('PageFamily', () => {
  it('4 known families (D2)', () => {
    expect(PAGE_FAMILIES).toEqual(['sales_page', 'advertorial', 'pdp_derived', 'unknown']);
  });

  it('isPageFamily narrows correctly', () => {
    expect(isPageFamily('sales_page')).toBe(true);
    expect(isPageFamily('nope')).toBe(false);
    expect(isPageFamily(42)).toBe(false);
    expect(isPageFamily(null)).toBe(false);
  });
});

describe('SemanticRegion criticality (D7)', () => {
  it('all critical kinds classified critical', () => {
    for (const k of CRITICAL_REGION_KINDS) {
      expect(criticalityOf(k)).toBe('critical');
    }
  });

  it('all non-critical kinds classified non_critical', () => {
    for (const k of NON_CRITICAL_REGION_KINDS) {
      expect(criticalityOf(k)).toBe('non_critical');
    }
  });

  it('critical + non-critical are disjoint', () => {
    const overlap = CRITICAL_REGION_KINDS.filter((k) =>
      (NON_CRITICAL_REGION_KINDS as readonly string[]).includes(k),
    );
    expect(overlap).toEqual([]);
  });

  it('SEMANTIC_REGION_KINDS is union of both', () => {
    const combined = [
      ...CRITICAL_REGION_KINDS,
      ...NON_CRITICAL_REGION_KINDS,
    ];
    expect(SEMANTIC_REGION_KINDS.length).toBe(combined.length);
    expect(new Set(SEMANTIC_REGION_KINDS)).toEqual(new Set(combined));
  });

  it('subheadline (Fase 11.1 D-11.4) presente como non_critical', () => {
    expect((NON_CRITICAL_REGION_KINDS as readonly string[]).includes('subheadline')).toBe(true);
    expect(criticalityOf('subheadline')).toBe('non_critical');
  });

  it('references/authority_citations NÃO presentes ainda (D-11.4)', () => {
    expect((SEMANTIC_REGION_KINDS as readonly string[]).includes('references')).toBe(false);
    expect((SEMANTIC_REGION_KINDS as readonly string[]).includes('authority_citations')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { assertVariantSource, mergeVslManifest, normalizeVslLocale } from '../variants.js';
describe('VSL variants', () => {
  it('normalizes only supported locales', () => { expect(normalizeVslLocale('ES')).toBe('es'); expect(() => normalizeVslLocale('ja')).toThrow(); });
  it('requires explicit immutable source and target separation', () => { expect(assertVariantSource('p','r','v').sourceRevisionId).toBe('r'); expect(() => assertVariantSource('p','r','p')).toThrow(); });
  it('merges manifest overrides without mutating base', () => { const b={assets:{hero:'a'},html:'base'}, r=mergeVslManifest(b,{assets:{hero:'b'}}); expect(r).toEqual({assets:{hero:'b'},html:'base'}); expect(b.assets.hero).toBe('a'); });
});

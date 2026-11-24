import { describe, expect, it } from 'vitest';

import { normalizeVslPathname } from '../pathnames.js';

describe('VSL pathname contract', () => {
  it('normalizes root and slugs', () => { expect(normalizeVslPathname('/')).toBe('/'); expect(normalizeVslPathname('produto-a/')).toBe('/produto-a'); });
  it('rejects traversal and query strings', () => { expect(() => normalizeVslPathname('/../x')).toThrow(); expect(() => normalizeVslPathname('/x?y=1')).toThrow(); expect(() => normalizeVslPathname('/%252e%252e/x')).toThrow(); });
});

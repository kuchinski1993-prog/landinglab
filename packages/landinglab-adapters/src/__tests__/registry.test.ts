import { describe, it, expect } from 'vitest';
import { createAdapterRegistry } from '../registry.js';
import type { ThemeAdapter } from '../theme-adapter.js';

const stub = (id: string): ThemeAdapter => ({
  id,
  families: ['sales_page'],
  detect: () => ({
    adapterId: id,
    family: 'sales_page',
    score: 0,
    evidence: { reasons: [], matchedRules: [] },
  }),
  extract: () => {
    throw new Error('not implemented');
  },
});

describe('AdapterRegistry', () => {
  it('registers + retrieves adapters', () => {
    const r = createAdapterRegistry();
    r.register(stub('kaching'));
    r.register(stub('aurivita'));
    expect(r.size()).toBe(2);
    expect(r.get('kaching')?.id).toBe('kaching');
    expect(r.list().map((a) => a.id).sort()).toEqual(['aurivita', 'kaching']);
  });

  it('rejects duplicate ids', () => {
    const r = createAdapterRegistry();
    r.register(stub('kaching'));
    expect(() => r.register(stub('kaching'))).toThrow(/duplicate/);
  });

  it('freeze blocks further register()', () => {
    const r = createAdapterRegistry();
    r.register(stub('a'));
    r.freeze();
    expect(r.isFrozen()).toBe(true);
    expect(() => r.register(stub('b'))).toThrow(/freeze/);
  });

  it('get() returns undefined for unknown', () => {
    const r = createAdapterRegistry();
    expect(r.get('nope')).toBeUndefined();
  });
});

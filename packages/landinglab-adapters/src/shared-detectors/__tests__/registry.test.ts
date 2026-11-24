import { describe, it, expect } from 'vitest';
import {
  createSharedDetectorRegistry,
  type SharedRegionDetector,
} from '../index.js';

function stub(id: string, targetKinds: readonly string[] = ['headline']): SharedRegionDetector {
  return {
    id,
    targetKinds: targetKinds as never,
    supportedFamilies: [],
    detect: () => ({
      detectorId: id,
      ownershipClaims: [],
      editableFields: [],
      unclassified: [],
      warnings: [],
      reasons: [],
    }),
  };
}

describe('SharedDetectorRegistry', () => {
  it('register one detector', () => {
    const r = createSharedDetectorRegistry();
    r.register(stub('cta'));
    expect(r.size()).toBe(1);
    expect(r.get('cta')?.id).toBe('cta');
  });

  it('duplicate ID rejected', () => {
    const r = createSharedDetectorRegistry();
    r.register(stub('a'));
    expect(() => r.register(stub('a'))).toThrow(/duplicate/);
  });

  it('freeze blocks register()', () => {
    const r = createSharedDetectorRegistry();
    r.register(stub('a'));
    r.freeze();
    expect(r.isFrozen()).toBe(true);
    expect(() => r.register(stub('b'))).toThrow(/freeze/);
  });

  it('list() ordena por id asc (determinístico independente da ordem de registro)', () => {
    const r1 = createSharedDetectorRegistry();
    r1.register(stub('zebra'));
    r1.register(stub('alpha'));
    r1.register(stub('mango'));

    const r2 = createSharedDetectorRegistry();
    r2.register(stub('alpha'));
    r2.register(stub('mango'));
    r2.register(stub('zebra'));

    expect(r1.list().map((d) => d.id)).toEqual(['alpha', 'mango', 'zebra']);
    expect(r2.list().map((d) => d.id)).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('get() undefined pra desconhecido', () => {
    const r = createSharedDetectorRegistry();
    expect(r.get('missing')).toBeUndefined();
  });
});

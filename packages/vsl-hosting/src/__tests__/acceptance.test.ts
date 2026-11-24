import { describe, expect, it } from 'vitest';

import { assertVslIsolation, buildVslLocaleMatrix } from '../acceptance.js';
describe('VSL multilingual acceptance', () => {
  it('builds the six-locale matrix with missing locales explicit', () => { const matrix=buildVslLocaleMatrix([{locale:'pt-BR',pageId:'p',revisionId:'r',reviewed:true,evidence:'e'}]); expect(matrix).toHaveLength(6); expect(matrix.find(x=>x.locale==='pt-BR')?.record?.pageId).toBe('p'); expect(matrix.find(x=>x.locale==='fr')?.record).toBeNull(); });
  it('requires independent reviewed evidence', () => { expect(assertVslIsolation([{locale:'en',pageId:'p1',revisionId:'r1',reviewed:true,evidence:'e'}])).toBe(true); expect(()=>assertVslIsolation([{locale:'en',pageId:'p1',revisionId:'r1',reviewed:false,evidence:''}])).toThrow(); });
});

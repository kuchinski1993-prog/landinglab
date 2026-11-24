import { describe, expect, it } from 'vitest';

import { mergeManualTranslation, translationCacheKey, validateTranslationBatch } from '../translation-ai.js';
describe('VSL translation review', () => {
  const unit={id:'u1',sourceHash:'h1',original:'Hello',type:'text' as const,locator:[0],context:'p'};
  it('validates exact unit/hash batches and contextual cache keys', () => { expect(validateTranslationBatch([unit],[{unitId:'u1',sourceHash:'h1',translated:'Olá',status:'proposed'}])).toHaveLength(1); expect(translationCacheKey('f','en','pt',[unit],'m','p')).not.toBe(translationCacheKey('f','es','pt',[unit],'m','p')); expect(()=>validateTranslationBatch([unit],[{unitId:'u1',sourceHash:'old',translated:'x',status:'proposed'}])).toThrow(); });
  it('never overwrites manual decisions', () => { const manual={unitId:'u1',sourceHash:'h1',translated:'Oi',status:'approved' as const,manual:true}; expect(mergeManualTranslation(manual,{unitId:'u1',sourceHash:'h1',translated:'Olá',status:'proposed'})).toBe(manual); });
});

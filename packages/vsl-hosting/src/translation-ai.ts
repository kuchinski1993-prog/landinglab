import { createHash } from 'node:crypto';

import type { VslTranslationUnit } from './translation-extract.js';

export type VslTranslationProposal = { unitId: string; sourceHash: string; translated: string; status: 'proposed'|'approved'|'rejected'; manual?: boolean };
export interface VslTranslationProvider { translate(input: { sourceLocale: string; targetLocale: string; units: VslTranslationUnit[]; model: string; promptVersion: string }): Promise<VslTranslationProposal[]>; }
export function translationCacheKey(familyId: string, sourceLocale: string, targetLocale: string, units: VslTranslationUnit[], model: string, promptVersion: string) { return createHash('sha256').update(JSON.stringify({familyId,sourceLocale,targetLocale,units:units.map(x=>[x.id,x.sourceHash,x.original]),model,promptVersion})).digest('hex'); }
export function validateTranslationBatch(units: VslTranslationUnit[], proposals: VslTranslationProposal[]) {
  const expected=new Set(units.map(x=>x.id)); if(proposals.some(x=>!expected.has(x.unitId)||!x.translated||x.sourceHash!==units.find(u=>u.id===x.unitId)?.sourceHash)) throw new Error('Invalid VSL translation batch'); return proposals;
}
export function mergeManualTranslation(existing: VslTranslationProposal | undefined, proposal: VslTranslationProposal) { return existing?.manual ? existing : proposal; }

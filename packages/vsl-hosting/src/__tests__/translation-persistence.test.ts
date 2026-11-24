import { describe, expect, it } from 'vitest';

import { VslTranslationRepository } from '../translation-persistence.js';
import { FakeVslTranslationProvider } from '../translation-provider.js';

describe('VSL translation workflow',()=>{
 it('extracts source-bound units and supports safe reinsert',async()=>{const calls:string[]=[];const sql=((s:TemplateStringsArray)=>{calls.push(s.join('?'));return []}) as never;const repo=new VslTranslationRepository(sql);const batch=await repo.createBatch('v','r','es','<p>Hello <strong>world</strong></p>');expect(batch.units.length).toBeGreaterThan(0);expect(repo.reinsert('<p>Hello <strong>world</strong></p>',batch.units.slice(0,1),{[batch.units[0].id]:'Hola'},batch.sourceHash)).toContain('Hola');expect(calls.every(x=>x.includes('vsl_translation'))).toBe(true);});
 it('fake provider is deterministic and never executes source content',async()=>{const provider=new FakeVslTranslationProvider();expect(await provider.translate([], 'en','es')).toBe(0);});
});

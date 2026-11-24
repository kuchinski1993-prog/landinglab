import { describe, expect, it } from 'vitest';

import { VSL_LOCALES, mergeVslManifest } from '../variants.js';
import { extractVslTranslationUnits, applyVslTranslations } from '../translation-extract.js';
import { FakeVslTranslationProvider } from '../translation-provider.js';

describe('VSL-12 local multilingual acceptance',()=>{
 it('covers six isolated locales, extraction, translation and manifest overrides',async()=>{
  const html='<html lang="en"><body><div class="quiz-step">Start quiz</div><button data-cta="1">Buy now</button></body></html>';
  const base=extractVslTranslationUnits(html); expect(VSL_LOCALES).toHaveLength(6); const provider=new FakeVslTranslationProvider(); expect(await provider.translate(base,'en','es')).toBeGreaterThan(0);
  for(const locale of VSL_LOCALES){const manifest=mergeVslManifest({locale,assets:{hero:'base'}},{assets:{hero:`${locale}-asset`}}) as any; expect(manifest.assets.hero).toBe(`${locale}-asset`);}
  const values=Object.fromEntries(base.map(unit=>[unit.id,`T:${unit.original}`])); expect(applyVslTranslations(html,base,values,base[0].sourceHash)).toContain('T:Start quiz');
 });
 it('does not share mutable manifest or page identity between variants',()=>{const a=mergeVslManifest({pageId:'a',assets:{}},{assets:{x:'a'}}) as any;const b=mergeVslManifest({pageId:'b',assets:{}},{assets:{x:'b'}}) as any;expect(a.pageId).not.toBe(b.pageId);expect(a.assets.x).not.toBe(b.assets.x);});
});

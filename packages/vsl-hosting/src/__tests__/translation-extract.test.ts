import { describe, expect, it } from 'vitest';

import { applyVslTranslations, extractVslTranslationUnits } from '../translation-extract.js';
describe('VSL safe extraction', () => {
  it('extracts text and functional attributes without executing scripts', () => { const html='<html><body><h1>Oferta 2x</h1><img alt="Produto"><script>window.bad=1</script></body></html>'; const units=extractVslTranslationUnits(html); expect(units.map(x=>x.original)).toEqual(expect.arrayContaining(['Oferta 2x','Produto'])); expect(units.some(x=>x.original.includes('window'))).toBe(false); });
  it('applies only escaped text against the exact source hash', () => { const html='<p>Olá</p>'; const units=extractVslTranslationUnits(html); const out=applyVslTranslations(html,units,{[units[0].id]:'Hello'},units[0].sourceHash); expect(out).toContain('Hello'); expect(()=>applyVslTranslations('<p>Changed</p>',units,{},units[0].sourceHash)).toThrow(); });
});

export const VSL_LOCALES = ['pt-BR','es','en','it','de','fr'] as const;
export type VslLocale = typeof VSL_LOCALES[number];
export function normalizeVslLocale(raw: string): VslLocale { const found=VSL_LOCALES.find(x=>x.toLowerCase()===raw.trim().toLowerCase()); if(!found) throw new Error('Unsupported VSL locale'); return found; }
export function assertVariantSource(sourcePageId: string, sourceRevisionId: string, targetPageId: string) { if (!sourcePageId || !sourceRevisionId || sourcePageId===targetPageId) throw new Error('Invalid VSL variant source'); return {sourcePageId,sourceRevisionId}; }
export function mergeVslManifest(base: Record<string, unknown>, overrides: Record<string, unknown>) { return structuredClone({...base,...overrides, assets:{...(base.assets as object ?? {}),...(overrides.assets as object ?? {})}}); }

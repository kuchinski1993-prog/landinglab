// Bundle Adapters — router (set/2026, Engine V2).
//
// Tenta cada adapter em ordem (mais específico → menos específico).
// Retorna primeiro que casou. Se nenhum casou, retorna 'none' + html intacto.

import { genericAdapter } from './generic.js';
import { kachingAdapter } from './kaching.js';
import type { BundleAdapter, BundleAdapterResult } from './types.js';

export type { BundleAdapterResult, DetectedBundleOffer } from './types.js';

const ADAPTERS: BundleAdapter[] = [
  kachingAdapter, // Mais específico primeiro
  genericAdapter,
];

/**
 * Aplica o primeiro adapter que detectar bundles no HTML.
 * Retorna `{ adapter: 'none' }` se nenhum casou.
 */
export function applyBundleAdapters(html: string): BundleAdapterResult {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.detect(html)) {
        const result = adapter.apply(html);
        // Só considera "sucesso" se extraiu >= 1 oferta
        if (result.offers.length > 0) return result;
      }
    } catch (err) {
      // Não deixa adapter quebrado abortar clone — pula pro próximo
      // eslint-disable-next-line no-console
      console.warn(`[bundle-adapter:${adapter.name}] falhou:`, err);
    }
  }
  return {
    adapter: 'none',
    offers: [],
    html,
    notes: 'Nenhum adapter detectou bundles',
  };
}

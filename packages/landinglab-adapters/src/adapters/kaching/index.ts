// KachingAdapter — Kaching BUNDLES COMPONENT adapter.
//
// IMPORTANTE (closure 10.3): este adapter reconhece o WIDGET Kaching Bundles,
// que é um componente embutido, NÃO um "theme" de página inteira. Klensia
// real é evidência viva: página tema PSS (§7.6 do processor) que HOSPEDA
// widget Kaching Bundles. Portanto:
//
//   - detect() alto em landing com widget Kaching = correto, mesmo se
//     a página global for PSS/Aurivita/outro theme.
//   - extract() só emite regiões que são realmente responsabilidade
//     do widget Kaching (bundles + price_block). Não emite cta_primary
//     nem product_json (esses pertencem a outros adapters/camadas).
//
// Fase 10.3: só lê (detect + extract). NÃO controla render. NÃO integra worker.
//
// Ver docs/architecture/adr-001-theme-adapter-contract.md §3.5 (D3/A6)
// e closure 10.3 (Anexo B — Page/Theme vs Embedded Component).

import type { ThemeAdapter, AdapterInput } from '../../theme-adapter.js';
import type { AdapterCandidate } from '../../types/detection.js';
import type { ExtractionResult } from '../../types/extraction.js';
import { detectKaching, KACHING_ADAPTER_ID } from './detect.js';
import { extractKaching } from './extract.js';

export const kachingAdapter: ThemeAdapter = Object.freeze({
  id: KACHING_ADAPTER_ID,
  families: ['sales_page'] as const,
  detect(input: AdapterInput): AdapterCandidate {
    return detectKaching(input);
  },
  extract(input: AdapterInput): ExtractionResult {
    return extractKaching(input);
  },
});

export { KACHING_ADAPTER_ID } from './detect.js';

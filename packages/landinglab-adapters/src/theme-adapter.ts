// ADR-001 §3.5 (D3 + A6) — ThemeAdapter interface.
//
// Adapter detecta/localiza/classifica/extrai modelo semântico.
// NÃO renderiza, NÃO muta HTML, NÃO conhece dados canônicos (bundle_offers),
// NÃO executa Shopify, NÃO implementa editor.

import type { PageFamily } from './types/page-family.js';
import type { AdapterCandidate } from './types/detection.js';
import type { ExtractionResult } from './types/extraction.js';

export interface AdapterInput {
  html: string;
  // Contexto opcional que o resolver conhece:
  hintedFamily?: PageFamily; // Ex.: landing_pages.landing_kind
  hintedAdapterId?: string; // Ex.: landing_pages.bundle_adapter
  landingPageId?: string;
}

export interface ThemeAdapter {
  readonly id: string; // 'kaching' | 'aurivita' | 'pss' | ...
  readonly families: readonly PageFamily[]; // Quais famílias este adapter suporta

  /**
   * Fast pass. Deve ser BARATO (regex/counts). Usado pelo resolver.
   * Não muta HTML. Não abre parse pesado se puder evitar.
   */
  detect(input: AdapterInput): AdapterCandidate;

  /**
   * Full pass. Chamado APENAS no adapter vencedor pelo resolver.
   * Extrai regiões, editable fields, unclassified.
   * Não muta HTML.
   */
  extract(input: AdapterInput): ExtractionResult;
}

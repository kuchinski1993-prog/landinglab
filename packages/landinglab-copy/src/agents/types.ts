// Shared types para os 6 copywriter/chief modules do Squad 2.
//
// Espelha packages/landinglab-research/src/agents/types.ts (Squad 1) —
// duplicado localmente pra evitar coupling entre squads (Wave 1 decision).
//
// Cada agent worker retorna um `CopyTraceEntry` (agregado em
// landing_generation_runs.agent_trace via orchestrator) + um `CopyWorkerOutput`
// contendo as contribuições parciais que o Copy Chief usa pra montar o deck.

import type { CopyDeck } from '../schema/copy-deck.js';

/** Trace unitário de uma invocação Claude. */
export interface CopyTraceEntry {
  agent: string;
  provider: 'anthropic' | (string & {});
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  status: 'ok' | 'partial' | 'failed';
  error?: string;
}

/**
 * Contribuições parciais de um copywriter — cada agent produz apenas alguns
 * blocos do CopyDeck. O Copy Chief combina as contribuições em um deck final.
 */
export interface CopyContributions {
  hooks?: CopyDeck['hooks'];
  subheadlines?: CopyDeck['subheadlines'];
  benefit_bullets?: CopyDeck['benefit_bullets'];
  ctas?: CopyDeck['ctas'];
  faq?: CopyDeck['faq'];
  offer_stack?: CopyDeck['offer_stack'];
  guarantee?: CopyDeck['guarantee'];
  urgency_copy?: CopyDeck['urgency_copy'];
  social_proof_blocks?: CopyDeck['social_proof_blocks'];
  /** VOC verbatim extraídos do pir.voc.language_bank e integrados no copy. */
  voc_verbatim_used?: CopyDeck['voc_verbatim_used'];
}

/** Output de um copywriter individual (Hormozi/Schwartz/Halbert/Cialdini/Voss). */
export interface CopyWorkerOutput {
  agent: 'hormozi' | 'schwartz' | 'halbert' | 'cialdini' | 'voss';
  contributions: CopyContributions;
  trace: CopyTraceEntry;
}

/**
 * Estrutura persistida por callers como fallback quando o agent falha
 * completamente (sem contribuições utilizáveis).
 */
export function makeFailedCopyWorkerOutput(
  agent: CopyWorkerOutput['agent'],
  error: string,
): CopyWorkerOutput {
  return {
    agent,
    contributions: {},
    trace: {
      agent,
      provider: 'anthropic',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      latency_ms: 0,
      status: 'failed',
      error,
    },
  };
}

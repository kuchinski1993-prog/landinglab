// ADR-001 §3.2 + §5 (D5 + A3) — Detection result.
// Resolver retorna candidates ordenados; escolhe apenas quando confidence
// + margin permitem. Ambiguidade é sinalizada, não resolvida silenciosamente.

import type { PageFamily } from './page-family.js';
import type { RegionEvidence } from './semantic-region.js';

export interface AdapterCandidate {
  adapterId: string; // 'kaching' | 'aurivita' | 'pss' | ...
  family: PageFamily;
  score: number; // 0..1
  evidence: RegionEvidence;
}

export type AdapterResolution = 'confident' | 'ambiguous' | 'no_match';

export interface DetectionResult {
  candidates: AdapterCandidate[]; // Sempre ordenados desc por score.
  chosen: AdapterCandidate | null; // null quando resolution != 'confident'.
  resolution: AdapterResolution;
  reasons: string[]; // Human-readable trace da decisão do resolver.
}

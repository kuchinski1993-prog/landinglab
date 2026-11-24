// ADR-001 §3.5 (D3) + Fase 10.3 §1 — Kaching detection.
//
// Combina múltiplas evidências estruturais. NUNCA usa URL/domínio.
// Score é soma capped em 1.0 dos scoreDelta das regras. Evidence inclui
// razão de cada regra que disparou.

import * as cheerio from 'cheerio';
import type { AdapterCandidate } from '../../types/detection.js';
import type { AdapterInput } from '../../theme-adapter.js';
import { runAllRules } from './rules.js';

export const KACHING_ADAPTER_ID = 'kaching';

export function detectKaching(input: AdapterInput): AdapterCandidate {
  const $ = cheerio.load(input.html);
  const outcomes = runAllRules($);

  const scoreSum = outcomes.reduce((acc, o) => acc + o.scoreDelta, 0);
  const score = Math.min(1, scoreSum);

  const matchedReasons = outcomes
    .filter((o) => o.scoreDelta > 0)
    .map((o) => o.reason);
  const missReasons = outcomes
    .filter((o) => o.scoreDelta === 0)
    .map((o) => o.reason);

  const matchedRules = outcomes
    .filter((o) => o.scoreDelta > 0)
    .map((o) => o.ruleId);

  // Evidence inclui matches + misses (transparência total).
  const reasons: string[] =
    matchedReasons.length > 0
      ? [
          `score=${score.toFixed(3)} matched=${matchedRules.length}`,
          ...matchedReasons,
          ...missReasons.map((m) => `-${m}`),
        ]
      : [`score=0 no rules matched`, ...missReasons];

  return {
    adapterId: KACHING_ADAPTER_ID,
    family: 'sales_page', // 10.3 §3 — Kaching adapter só sales_page nesta subfase
    score,
    evidence: { reasons, matchedRules },
  };
}

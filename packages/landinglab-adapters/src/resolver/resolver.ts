// ADR-001 §5 (D5 + A3) — Resolver.
//
// Determinístico. Sinaliza ambiguidade em vez de resolver silenciosamente.
// NUNCA lança exceção por ambiguidade — retorna DetectionResult com
// resolution='ambiguous' e reasons preenchidas. Consumidor decide o fallback
// (durante Fase 10, fallback = pipeline legado).

import type { ThemeAdapter, AdapterInput } from '../theme-adapter.js';
import type {
  AdapterCandidate,
  DetectionResult,
} from '../types/detection.js';
import { INITIAL_THRESHOLDS, type Thresholds } from './thresholds.js';

export interface ResolverOptions {
  thresholds?: Thresholds;
}

export function resolve(
  input: AdapterInput,
  adapters: readonly ThemeAdapter[],
  options: ResolverOptions = {},
): DetectionResult {
  const thresholds = options.thresholds ?? INITIAL_THRESHOLDS;

  // 1. Run detect() em todos, filtra score > 0.
  const raw: AdapterCandidate[] = [];
  const reasons: string[] = [];

  for (const adapter of adapters) {
    let cand: AdapterCandidate;
    try {
      cand = adapter.detect(input);
    } catch (err) {
      reasons.push(`adapter=${adapter.id} threw during detect: ${errorMessage(err)}`);
      continue;
    }
    if (cand.score > 0) {
      raw.push(cand);
    }
  }

  // 2. Aplica hint bias ANTES do sort. Cap em 1.0.
  const biased = raw.map((c) => {
    if (input.hintedAdapterId && input.hintedAdapterId === c.adapterId) {
      const boosted = Math.min(1, c.score + thresholds.HINT_BIAS);
      if (boosted !== c.score) {
        reasons.push(
          `adapter=${c.adapterId} hint bias applied: ${c.score.toFixed(3)} → ${boosted.toFixed(3)}`,
        );
      }
      return { ...c, score: boosted };
    }
    return c;
  });

  // 3. Sort desc por score. Empate resolve por adapterId asc (determinístico).
  const candidates = biased.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.adapterId.localeCompare(b.adapterId);
  });

  if (candidates.length === 0) {
    reasons.push('no adapters returned score > 0');
    return {
      candidates: [],
      chosen: null,
      resolution: 'no_match',
      reasons,
    };
  }

  const top = candidates[0]!;
  const runnerUp = candidates[1] ?? null;

  // 4. Decide resolução.
  if (top.score < thresholds.CONFIDENCE_THRESHOLD) {
    reasons.push(
      `top score ${top.score.toFixed(3)} < CONFIDENCE_THRESHOLD ${thresholds.CONFIDENCE_THRESHOLD}`,
    );
    return { candidates, chosen: null, resolution: 'no_match', reasons };
  }

  if (runnerUp !== null) {
    const margin = top.score - runnerUp.score;
    if (margin < thresholds.MARGIN_THRESHOLD) {
      reasons.push(
        `margin ${margin.toFixed(3)} < MARGIN_THRESHOLD ${thresholds.MARGIN_THRESHOLD} ` +
          `(top=${top.adapterId} @ ${top.score.toFixed(3)}, runnerUp=${runnerUp.adapterId} @ ${runnerUp.score.toFixed(3)})`,
      );
      return { candidates, chosen: null, resolution: 'ambiguous', reasons };
    }
  }

  reasons.push(
    `chosen adapter=${top.adapterId} score=${top.score.toFixed(3)} ` +
      (runnerUp ? `margin=${(top.score - runnerUp.score).toFixed(3)}` : 'unopposed'),
  );

  return { candidates, chosen: top, resolution: 'confident', reasons };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ADR-001 §5 + A1 — INITIAL CALIBRATION VALUES.
//
// Não são invariantes permanentes. Shadow mode (10.4) poderá ajustar com
// evidência (fingerprints distintos, comparison.match, overallConfidence).
// Toda alteração deve ser feita via PR referenciando ADR-001 e a evidência.

export interface Thresholds {
  // Score mínimo do candidato #1 para resultado 'confident'.
  CONFIDENCE_THRESHOLD: number;
  // Diferença mínima entre score do #1 e #2 para resultado 'confident'.
  // Se #2 estiver muito perto, resolve para 'ambiguous'.
  MARGIN_THRESHOLD: number;
  // Confidence mínima em região crítica antes que renderer/publish possam agir.
  // Abaixo disso → adapter recusa autoridade sobre a região (D7).
  CRITICAL_MIN_CONFIDENCE: number;
  // Hint bias: se hintedAdapterId bate com um candidate, aplicar este offset
  // antes do sort (capped em 1.0). Motivação: bundle_adapter já foi validado
  // por humano em algum momento → merece prior.
  HINT_BIAS: number;
}

export const INITIAL_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  CONFIDENCE_THRESHOLD: 0.7,
  MARGIN_THRESHOLD: 0.15,
  CRITICAL_MIN_CONFIDENCE: 0.6,
  HINT_BIAS: 0.1,
});

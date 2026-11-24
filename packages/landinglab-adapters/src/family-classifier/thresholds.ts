// ADR-002 §4.2 — Family classifier thresholds.
//
// Não são invariantes permanentes. Podem ser ajustadas com evidência de
// runtime (fase 11.4 shadow) — mesma filosofia dos INITIAL_THRESHOLDS
// do ADR-001 (A1 v1.1).

export interface FamilyThresholds {
  /** Score mínimo do candidato #1 para resultado 'confident'. */
  CLASSIFIER_MIN_CONFIDENCE: number;
  /** Diferença mínima entre #1 e #2 pra 'confident'. Senão 'ambiguous'. */
  CLASSIFIER_MARGIN_THRESHOLD: number;
}

export const INITIAL_FAMILY_THRESHOLDS: Readonly<FamilyThresholds> = Object.freeze({
  CLASSIFIER_MIN_CONFIDENCE: 0.6,
  CLASSIFIER_MARGIN_THRESHOLD: 0.1,
});

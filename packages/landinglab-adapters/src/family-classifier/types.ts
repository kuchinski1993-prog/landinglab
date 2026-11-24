// ADR-002 §4 — PageFamilyClassifier types.
//
// Pure/read-only. Zero I/O, zero mutation.

import type { PageFamily } from '../types/page-family.js';

export type FamilySource = 'user_hint' | 'classifier_auto' | 'default_unknown';

export type FamilyResolution = 'confident' | 'ambiguous' | 'unknown';

/**
 * Uma evidência estrutural que aponta pra uma family.
 * Múltiplas contribuem pro score final por family.
 */
export interface FamilyEvidence {
  ruleId: string;
  family: PageFamily;
  hits: number;
  scoreDelta: number;
  reason: string;
  /** Marca evidência auxiliar (A1 do ADR-002). Não pode sozinha produzir confident. */
  auxiliary?: boolean;
}

export interface FamilyCandidate {
  family: PageFamily;
  score: number; // 0..1
  evidence: FamilyEvidence[];
}

export interface FamilyClassifierInput {
  html: string;
  /** URL fonte opcional (A1: auxiliar, nunca primary). */
  sourceUrl?: string | null;
  /** User hint explícito (persistido em landing_pages.landing_kind). */
  userHint?: PageFamily | null;
}

export interface FamilyClassifierResult {
  family: PageFamily;
  familySource: FamilySource;
  familyConfidence: number;
  familyResolution: FamilyResolution;
  candidates: FamilyCandidate[];
  warnings: FamilyWarning[];
  reasons: string[];
}

export interface FamilyWarning {
  severity: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  family?: PageFamily;
}

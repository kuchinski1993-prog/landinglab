// ADR-002 §4 — PageFamilyClassifier.
//
// Pure/read-only. Zero I/O, zero mutation.
//
// Contrato:
//   - User hint explícito sempre wins (D-11.1). Classifier auto só decide
//     quando landing_kind='unknown' (userHint null/undefined ou 'unknown').
//   - A1: source URL é evidence auxiliar. Sozinha NUNCA produz confident.
//   - A3: preserva multi-dimensional confidence (não reduz a overall único).
//   - Nunca lança. Retorna FamilyClassifierResult sempre.

import * as cheerio from 'cheerio';
import type { PageFamily } from '../types/page-family.js';
import { isPageFamily } from '../types/page-family.js';
import {
  INITIAL_FAMILY_THRESHOLDS,
  type FamilyThresholds,
} from './thresholds.js';
import { STRUCTURAL_RULES, URL_RULES } from './rules.js';
import type {
  FamilyCandidate,
  FamilyClassifierInput,
  FamilyClassifierResult,
  FamilyEvidence,
  FamilyWarning,
} from './types.js';

export interface ClassifierOptions {
  thresholds?: FamilyThresholds;
}

export function classifyPageFamily(
  input: FamilyClassifierInput,
  options: ClassifierOptions = {},
): FamilyClassifierResult {
  const thresholds = options.thresholds ?? INITIAL_FAMILY_THRESHOLDS;
  const warnings: FamilyWarning[] = [];

  // 1. User hint autoritativo — se explícito e válido, wins.
  //    'unknown' é tratado como NÃO-hint (permite classifier rodar).
  const userHint = normalizeUserHint(input.userHint);
  if (userHint && userHint !== 'unknown') {
    return handleUserHint(userHint, input, thresholds);
  }

  // 2. Roda regras estruturais + URL (auxiliar).
  const candidates = runAllRules(input, thresholds);

  // 3. Decide resolução.
  return decide(candidates, thresholds, warnings, 'classifier_auto');
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function normalizeUserHint(hint: PageFamily | null | undefined): PageFamily | null {
  if (hint === null || hint === undefined) return null;
  if (isPageFamily(hint)) return hint;
  return null;
}

function handleUserHint(
  userHint: PageFamily,
  input: FamilyClassifierInput,
  thresholds: FamilyThresholds,
): FamilyClassifierResult {
  // Roda classifier automático como sanity — warn se diverge.
  const autoCandidates = runAllRules(input, thresholds);
  const autoDecision = decide(autoCandidates, thresholds, [], 'classifier_auto');

  const warnings: FamilyWarning[] = [];
  if (
    autoDecision.familyResolution === 'confident' &&
    autoDecision.family !== userHint
  ) {
    warnings.push({
      severity: 'warn',
      code: 'user_hint_diverges_from_classifier',
      message:
        `user_hint='${userHint}' but classifier confident='${autoDecision.family}' ` +
        `(score=${autoDecision.familyConfidence.toFixed(3)})`,
      family: autoDecision.family,
    });
  }

  return {
    family: userHint,
    familySource: 'user_hint',
    familyConfidence: 1.0,
    familyResolution: 'confident',
    candidates: autoCandidates,
    warnings,
    reasons: [
      `user_hint=${userHint} (authoritative)`,
      ...autoDecision.reasons.map((r) => `sanity:${r}`),
    ],
  };
}

function runAllRules(
  input: FamilyClassifierInput,
  _thresholds: FamilyThresholds,
): FamilyCandidate[] {
  const $ = cheerio.load(input.html);

  const allEvidence: FamilyEvidence[] = [];

  for (const rule of STRUCTURAL_RULES) {
    try {
      allEvidence.push(rule({ $ }));
    } catch (err) {
      // Regra defeituosa não deve derrubar classifier. Silencia.
      allEvidence.push({
        ruleId: 'error',
        family: 'unknown',
        hits: 0,
        scoreDelta: 0,
        reason: `rule_error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  for (const rule of URL_RULES) {
    try {
      allEvidence.push(rule(input.sourceUrl));
    } catch {
      // idem
    }
  }

  return aggregateByFamily(allEvidence);
}

function aggregateByFamily(evidence: FamilyEvidence[]): FamilyCandidate[] {
  const buckets = new Map<PageFamily, FamilyEvidence[]>();

  for (const ev of evidence) {
    if (ev.family === 'unknown') continue;
    const existing = buckets.get(ev.family) ?? [];
    existing.push(ev);
    buckets.set(ev.family, existing);
  }

  const candidates: FamilyCandidate[] = [];
  for (const [family, evList] of buckets.entries()) {
    const primaryScore = evList
      .filter((e) => !e.auxiliary)
      .reduce((sum, e) => sum + e.scoreDelta, 0);
    const auxiliaryScore = evList
      .filter((e) => e.auxiliary)
      .reduce((sum, e) => sum + e.scoreDelta, 0);
    // A1 do ADR-002: auxiliary só soma ao primário; nunca sozinho pode
    // atingir threshold. Cap explícito em 0.05 total pra segurança.
    const cappedAux = Math.min(auxiliaryScore, 0.05);
    const total = Math.min(1, primaryScore + cappedAux);
    candidates.push({
      family,
      score: total,
      evidence: evList.filter((e) => e.scoreDelta > 0),
    });
  }

  // Determinístico: sort desc por score, tie-break por family name asc.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.family.localeCompare(b.family);
  });

  return candidates;
}

function decide(
  candidates: FamilyCandidate[],
  thresholds: FamilyThresholds,
  warnings: FamilyWarning[],
  source: 'classifier_auto',
): FamilyClassifierResult {
  const reasons: string[] = [];

  if (candidates.length === 0) {
    reasons.push('no candidates emitted score > 0');
    return {
      family: 'unknown',
      familySource: 'default_unknown',
      familyConfidence: 0,
      familyResolution: 'unknown',
      candidates: [],
      warnings,
      reasons,
    };
  }

  const top = candidates[0]!;
  const runnerUp = candidates[1] ?? null;

  // A1 enforcement: se top só tem evidência auxiliar (todas primary=0),
  // NUNCA confident, mesmo que sozinho atinja threshold (que é impossível
  // com cap 0.05 < 0.60, mas defensive check).
  const topHasPrimary = top.evidence.some((e) => !e.auxiliary);
  if (!topHasPrimary && top.score > 0) {
    reasons.push(
      `top family=${top.family} has only auxiliary evidence — not confident`,
    );
    return {
      family: 'unknown',
      familySource: 'default_unknown',
      familyConfidence: 0,
      familyResolution: 'unknown',
      candidates,
      warnings,
      reasons,
    };
  }

  // Threshold
  if (top.score < thresholds.CLASSIFIER_MIN_CONFIDENCE) {
    reasons.push(
      `top score ${top.score.toFixed(3)} < CLASSIFIER_MIN_CONFIDENCE ` +
        `${thresholds.CLASSIFIER_MIN_CONFIDENCE}`,
    );
    return {
      family: 'unknown',
      familySource: 'default_unknown',
      familyConfidence: 0,
      familyResolution: 'unknown',
      candidates,
      warnings,
      reasons,
    };
  }

  // Margin
  if (runnerUp !== null) {
    const margin = top.score - runnerUp.score;
    if (margin < thresholds.CLASSIFIER_MARGIN_THRESHOLD) {
      reasons.push(
        `margin ${margin.toFixed(3)} < CLASSIFIER_MARGIN_THRESHOLD ` +
          `${thresholds.CLASSIFIER_MARGIN_THRESHOLD}: ` +
          `top=${top.family}@${top.score.toFixed(3)} vs ` +
          `runnerUp=${runnerUp.family}@${runnerUp.score.toFixed(3)}`,
      );
      warnings.push({
        severity: 'info',
        code: 'ambiguous_family',
        message:
          `Ambiguous: ${top.family}@${top.score.toFixed(3)} vs ` +
          `${runnerUp.family}@${runnerUp.score.toFixed(3)}`,
      });
      return {
        family: 'unknown',
        familySource: 'default_unknown',
        familyConfidence: 0,
        familyResolution: 'ambiguous',
        candidates,
        warnings,
        reasons,
      };
    }
  }

  reasons.push(
    `chosen family=${top.family} score=${top.score.toFixed(3)} ` +
      (runnerUp
        ? `margin=${(top.score - runnerUp.score).toFixed(3)}`
        : 'unopposed'),
  );
  return {
    family: top.family,
    familySource: source,
    familyConfidence: top.score,
    familyResolution: 'confident',
    candidates,
    warnings,
    reasons,
  };
}

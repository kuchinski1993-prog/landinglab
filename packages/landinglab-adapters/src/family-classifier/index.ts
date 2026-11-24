// Public API — family classifier

export { classifyPageFamily, type ClassifierOptions } from './classifier.js';
export {
  INITIAL_FAMILY_THRESHOLDS,
  type FamilyThresholds,
} from './thresholds.js';
export type {
  FamilyCandidate,
  FamilyClassifierInput,
  FamilyClassifierResult,
  FamilyEvidence,
  FamilyResolution,
  FamilySource,
  FamilyWarning,
} from './types.js';

// Public API — shared detector foundation (Fase 11.2)

export type {
  DomScope,
} from './dom-scope.js';
export {
  buildDomScope,
  scopeContains,
  scopeEquals,
  scopeOverlaps,
} from './dom-scope.js';

export type {
  ConflictResolution,
  LoserReason,
  OriginType,
  RegionConflict,
  RegionOwnershipClaim,
} from './ownership.js';
export {
  DEFAULT_PRIORITY_BY_ORIGIN,
  isOriginAllowedForKind,
  KIND_OWNERSHIP_DEFAULTS,
  resolveOwnership,
} from './ownership.js';

export type {
  SharedDetectorContext,
  SharedDetectorResult,
  SharedRegionDetector,
} from './types.js';

export {
  createSharedDetectorRegistry,
  SharedDetectorRegistry,
} from './registry.js';

export type {
  DetectorRun,
  SharedDetectorAggregate,
} from './orchestrator.js';
export { runSharedDetectors } from './orchestrator.js';

// Fase 11.3 — Concrete high-precision detectors
export {
  accordionDetector,
  articleDetector,
  footerDetector,
  shopifyCtaDetector,
} from './detectors/index.js';

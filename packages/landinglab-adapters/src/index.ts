// Public API — @blackshop/landinglab-adapters
//
// Package independente do worker (ADR-001 A7). Consumido em 10.4+ pelo
// apps/worker; futuro backoffice/editor também consumirá.

export * from './types/index.js';
export type { ThemeAdapter, AdapterInput } from './theme-adapter.js';
export { resolve, INITIAL_THRESHOLDS } from './resolver/index.js';
export type { ResolverOptions, Thresholds } from './resolver/index.js';
export { createAdapterRegistry, AdapterRegistry } from './registry.js';

// Concrete adapters
export { kachingAdapter, KACHING_ADAPTER_ID } from './adapters/kaching/index.js';

// Family classifier (Fase 11.1)
export {
  classifyPageFamily,
  INITIAL_FAMILY_THRESHOLDS,
} from './family-classifier/index.js';
export type {
  ClassifierOptions,
  FamilyCandidate,
  FamilyClassifierInput,
  FamilyClassifierResult,
  FamilyEvidence,
  FamilyResolution,
  FamilySource,
  FamilyThresholds,
  FamilyWarning,
} from './family-classifier/index.js';

// Shared detector foundation (Fase 11.2)
export {
  buildDomScope,
  createSharedDetectorRegistry,
  DEFAULT_PRIORITY_BY_ORIGIN,
  isOriginAllowedForKind,
  KIND_OWNERSHIP_DEFAULTS,
  resolveOwnership,
  runSharedDetectors,
  scopeContains,
  scopeEquals,
  scopeOverlaps,
  SharedDetectorRegistry,
  // Fase 11.3 — Concrete detectors
  accordionDetector,
  articleDetector,
  footerDetector,
  shopifyCtaDetector,
} from './shared-detectors/index.js';
export type {
  ConflictResolution,
  DetectorRun,
  DomScope,
  LoserReason,
  OriginType,
  RegionConflict,
  RegionOwnershipClaim,
  SharedDetectorAggregate,
  SharedDetectorContext,
  SharedDetectorResult,
  SharedRegionDetector,
} from './shared-detectors/index.js';

// Fase 11.4 — Semantic mapper
export { computePageSemanticModel } from './semantic-mapper/index.js';
export type {
  ComponentDetection,
  PageSemanticModel,
  RegionEntry,
  RegionSource,
  SemanticMapperInput,
} from './semantic-mapper/index.js';

// Fase 11.5 — Image semantic slots
export { computeImageSlots } from './image-slots/index.js';
export type {
  ImageOcrMetadataEntry,
  ImageSlotKind,
  ImageSlotMapperInput,
  ImageSlotMapperResult,
  SemanticImageSlot,
} from './image-slots/index.js';

// Fase 11.6 — Text semantic blocks
export { computeTextBlocks } from './text-blocks/index.js';
export type {
  SemanticTextBlock,
  TextBlockKind,
  TextBlockMapperInput,
  TextBlockMapperResult,
  TextCapability,
} from './text-blocks/index.js';

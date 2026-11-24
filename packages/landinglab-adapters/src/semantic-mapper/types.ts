// ADR-002 §13 + 11.4.1 — PageSemanticModel types.
//
// Runtime model. NÃO persistido (D-11.2/D-11.6/D-11.8).

import type { AdapterCandidate } from '../types/detection.js';
import type { EditableField } from '../types/editable-field.js';
import type {
  AdapterWarning,
  UnclassifiedElement,
} from '../types/extraction.js';
import type { PageFamily } from '../types/page-family.js';
import type {
  SemanticRegion,
  SemanticRegionKind,
} from '../types/semantic-region.js';
import type {
  FamilyClassifierResult,
  FamilySource,
} from '../family-classifier/types.js';
import type { RegionConflict } from '../shared-detectors/ownership.js';
import type {
  ImageOcrMetadataEntry,
  SemanticImageSlot,
} from '../image-slots/types.js';
import type { SemanticTextBlock } from '../text-blocks/types.js';

export type { ImageOcrMetadataEntry, SemanticImageSlot, SemanticTextBlock };

/**
 * Origem de uma região no PageSemanticModel unificado.
 */
export type RegionSource =
  | 'component_adapter'
  | 'shared_detector'
  | 'page_theme_adapter'
  | 'inherited'; // Emitido por origem que não foi detector rodado (ex.: extraído por Kaching adapter que roda fora deste mapper)

export interface RegionEntry {
  kind: SemanticRegionKind;
  source: RegionSource;
  ownerId: string; // ID do detector/adapter que emitiu
  region: SemanticRegion;
  instanceId: string; // DomScope.instanceId
  structuralPath: string; // DomScope.structuralPath
  confidence: number;
}

export interface ComponentDetection {
  componentId: string;
  adapterId: string;
  score: number;
  overallConfidence: number;
  bundleRegionSelector: string | null;
  cards: number;
}

export interface PageSemanticModel {
  landingPageId?: string;
  computedAt: string; // ISO timestamp (só metadata; não afeta determinismo do conteúdo)

  // Family
  family: PageFamily;
  familySource: FamilySource;
  familyConfidence: number;
  familyClassifier: FamilyClassifierResult;

  // Component adapters (Kaching hoje)
  themeCandidates: AdapterCandidate[];
  components: ComponentDetection[];

  // Regiões union
  regions: RegionEntry[];

  // Editable fields
  editableFields: EditableField[];

  // Health
  unclassified: UnclassifiedElement[];
  warnings: AdapterWarning[];
  conflicts: RegionConflict[];

  // Fase 11.5 — Image slots (optional; presente quando ocrMetadata passado)
  imageSlots: SemanticImageSlot[];

  // Fase 11.6 — Text blocks
  textBlocks: SemanticTextBlock[];

  // Aggregated confidence
  overallConfidence: number;
  criticalRegionsHealthy: boolean;

  // Diagnóstico (opcional, poluição controlada)
  meta: {
    detectorsRun: number;
    adaptersConsulted: number;
    warningsCount: number;
    conflictsCount: number;
  };
}

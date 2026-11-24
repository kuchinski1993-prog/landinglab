// ADR-001 §3.3 (D6 + D7) — ExtractionResult.
// Runtime model. NADA persistido nesta fase (D6/A1).

import type { PageFamily } from './page-family.js';
import type {
  SemanticRegion,
  SemanticRegionKind,
} from './semantic-region.js';
import type { EditableField } from './editable-field.js';

export interface UnclassifiedElement {
  selector: string;
  reason: string; // Ex.: 'detected block with no matching rule'
  // Palpite fraco, opt-in. Adapter NÃO adivinha por default (§4).
  suggestedKinds?: SemanticRegionKind[];
}

export type WarningSeverity = 'info' | 'warn' | 'error';

export interface AdapterWarning {
  severity: WarningSeverity;
  code: string; // 'ambiguous_bundle_cards' | 'missing_cta' | 'critical_region_low_confidence' | ...
  message: string;
  region?: SemanticRegionKind;
}

export interface ExtractionResult {
  family: PageFamily;
  adapterId: string;
  regions: SemanticRegion[];
  editableFields: EditableField[];
  unclassified: UnclassifiedElement[];
  overallConfidence: number; // 0..1 — derivado das regiões críticas (§6)
  warnings: AdapterWarning[];
}

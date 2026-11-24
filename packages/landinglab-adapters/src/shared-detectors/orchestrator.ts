// ADR-002 §11.2 §10-11 — runSharedDetectors orchestrator.
//
// Executa todos os detectors registrados. Isola falhas. Ordem determinística.
// NUNCA lança pro caller.

import type { AdapterWarning, UnclassifiedElement } from '../types/extraction.js';
import type { EditableField } from '../types/editable-field.js';
import type { RegionOwnershipClaim } from './ownership.js';
import type { SharedDetectorRegistry } from './registry.js';
import type { SharedDetectorContext } from './types.js';

export interface SharedDetectorAggregate {
  /** Todos os claims agregados de todos os detectors. Ordem: por detector.id asc, depois pela ordem interna do detector. */
  claims: RegionOwnershipClaim[];
  editableFields: EditableField[];
  unclassified: UnclassifiedElement[];
  warnings: AdapterWarning[];
  /**
   * Sumário por detector. Facilita observability em logs.
   */
  detectorRuns: DetectorRun[];
}

export interface DetectorRun {
  detectorId: string;
  ran: boolean; // false se skipped por family mismatch
  skippedReason?: 'family_mismatch';
  claimCount: number;
  editableFieldCount: number;
  unclassifiedCount: number;
  warningCount: number;
  errorMessage?: string; // presente se detector lançou
}

export function runSharedDetectors(
  ctx: SharedDetectorContext,
  registry: SharedDetectorRegistry,
): SharedDetectorAggregate {
  const claims: RegionOwnershipClaim[] = [];
  const editableFields: EditableField[] = [];
  const unclassified: UnclassifiedElement[] = [];
  const warnings: AdapterWarning[] = [];
  const detectorRuns: DetectorRun[] = [];

  // Registry.list() já retorna sorted asc por id — determinístico.
  for (const detector of registry.list()) {
    // Family filter (§11)
    const supports =
      detector.supportedFamilies.length === 0 ||
      detector.supportedFamilies.includes(ctx.family);
    if (!supports) {
      detectorRuns.push({
        detectorId: detector.id,
        ran: false,
        skippedReason: 'family_mismatch',
        claimCount: 0,
        editableFieldCount: 0,
        unclassifiedCount: 0,
        warningCount: 0,
      });
      continue;
    }

    // Executa com isolation
    try {
      const result = detector.detect(ctx);

      claims.push(...result.ownershipClaims);
      editableFields.push(...result.editableFields);
      unclassified.push(...result.unclassified);
      warnings.push(...result.warnings);

      detectorRuns.push({
        detectorId: detector.id,
        ran: true,
        claimCount: result.ownershipClaims.length,
        editableFieldCount: result.editableFields.length,
        unclassifiedCount: result.unclassified.length,
        warningCount: result.warnings.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push({
        severity: 'error',
        code: 'shared_detector_error',
        message: `Detector '${detector.id}' threw: ${msg}`,
      });
      detectorRuns.push({
        detectorId: detector.id,
        ran: true,
        claimCount: 0,
        editableFieldCount: 0,
        unclassifiedCount: 0,
        warningCount: 0,
        errorMessage: msg,
      });
    }
  }

  return { claims, editableFields, unclassified, warnings, detectorRuns };
}

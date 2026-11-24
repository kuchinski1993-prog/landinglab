// ADR-002 §13 + 11.4 — semantic-mapper.
//
// Puro/read-only. Zero I/O. Zero mutation. Nunca lança.
//
// Compõe:
//   PageFamilyClassifier + AdapterRegistry (component/theme) + SharedDetectorRegistry
//   → PageSemanticModel

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

import type { FamilyClassifierInput } from '../family-classifier/types.js';
import { classifyPageFamily } from '../family-classifier/classifier.js';
import type { AdapterCandidate } from '../types/detection.js';
import type { EditableField } from '../types/editable-field.js';
import type {
  AdapterWarning,
  ExtractionResult,
  UnclassifiedElement,
} from '../types/extraction.js';
import type { PageFamily } from '../types/page-family.js';
import type {
  SemanticRegion,
  SemanticRegionKind,
} from '../types/semantic-region.js';
import { CRITICAL_REGION_KINDS } from '../types/semantic-region.js';
import type { ThemeAdapter } from '../theme-adapter.js';
import type { AdapterRegistry } from '../registry.js';
import { resolve as resolveAdapters } from '../resolver/resolver.js';
import { buildDomScope } from '../shared-detectors/dom-scope.js';
import type { DomScope } from '../shared-detectors/dom-scope.js';
import type { RegionOwnershipClaim } from '../shared-detectors/ownership.js';
import { resolveOwnership } from '../shared-detectors/ownership.js';
import { runSharedDetectors } from '../shared-detectors/orchestrator.js';
import type { SharedDetectorRegistry } from '../shared-detectors/registry.js';
import { computeImageSlots } from '../image-slots/mapper.js';
import type {
  ImageOcrMetadataEntry,
  SemanticImageSlot,
} from '../image-slots/types.js';
import { computeTextBlocks } from '../text-blocks/mapper.js';
import type { SemanticTextBlock } from '../text-blocks/types.js';
import type {
  ComponentDetection,
  PageSemanticModel,
  RegionEntry,
  RegionSource,
} from './types.js';

export interface SemanticMapperInput {
  html: string;
  landingPageId?: string;
  userHint?: PageFamily | null;
  sourceUrl?: string | null;
  /**
   * Adapter registry (component/theme). Ex.: [kachingAdapter].
   * Se omitido, apenas shared detectors rodam.
   */
  adapterRegistry?: AdapterRegistry;
  /**
   * Shared detector registry. Ex.: shopify-cta + article + accordion + footer.
   */
  sharedRegistry?: SharedDetectorRegistry;
  /**
   * Timestamp opcional — se omitido, usa 'unknown' (mantém determinismo em tests).
   */
  computedAt?: string;
  /**
   * Fase 11.5 — imageOcrMetadata cache do worker. Opcional.
   */
  ocrMetadata?: readonly ImageOcrMetadataEntry[];
}

/**
 * Executa mapping completo. NUNCA lança. Returns PageSemanticModel sempre.
 */
export function computePageSemanticModel(
  input: SemanticMapperInput,
): PageSemanticModel {
  let $: CheerioAPI;
  try {
    $ = cheerio.load(input.html);
  } catch (err) {
    return emptyModelWithError(input, `cheerio_load_failed: ${errStr(err)}`);
  }

  // Step 1: Family
  const familyInput: FamilyClassifierInput = {
    html: input.html,
    userHint: input.userHint ?? null,
    sourceUrl: input.sourceUrl ?? null,
  };
  let familyClassifier;
  try {
    familyClassifier = classifyPageFamily(familyInput);
  } catch (err) {
    return emptyModelWithError(input, `family_classifier_failed: ${errStr(err)}`);
  }

  const warnings: AdapterWarning[] = [];
  const unclassified: UnclassifiedElement[] = [];
  const editableFields: EditableField[] = [];
  const claims: RegionOwnershipClaim[] = [];
  const themeCandidates: AdapterCandidate[] = [];
  const components: ComponentDetection[] = [];
  let adaptersConsulted = 0;
  let detectorsRun = 0;

  // Step 2: Component adapters (Kaching hoje)
  if (input.adapterRegistry) {
    try {
      const adapters = input.adapterRegistry.list();
      const detection = resolveAdapters(
        {
          html: input.html,
          hintedFamily: familyClassifier.family,
          landingPageId: input.landingPageId,
        },
        adapters,
      );
      adaptersConsulted = adapters.length;
      themeCandidates.push(...detection.candidates);

      if (detection.chosen) {
        const adapter = input.adapterRegistry.get(detection.chosen.adapterId);
        if (adapter) {
          try {
            const extraction = adapter.extract({
              html: input.html,
              hintedFamily: familyClassifier.family,
              landingPageId: input.landingPageId,
            });
            const componentInfo = buildComponentDetection(
              adapter,
              detection.chosen,
              extraction,
            );
            components.push(componentInfo);
            editableFields.push(...extraction.editableFields);
            unclassified.push(...extraction.unclassified);
            warnings.push(...extraction.warnings);

            // Converte regiões do adapter em ownership claims
            const componentClaims = extractionRegionsToClaims(
              $,
              extraction,
              adapter.id,
            );
            claims.push(...componentClaims);
          } catch (err) {
            warnings.push({
              severity: 'error',
              code: 'component_extract_error',
              message: `${adapter.id}.extract threw: ${errStr(err)}`,
            });
          }
        }
      }
    } catch (err) {
      warnings.push({
        severity: 'error',
        code: 'adapter_resolver_error',
        message: `resolveAdapters threw: ${errStr(err)}`,
      });
    }
  }

  // Step 3: Shared detectors
  if (input.sharedRegistry) {
    try {
      const aggregate = runSharedDetectors(
        {
          html: input.html,
          $,
          family: familyClassifier.family,
          familyConfidence: familyClassifier.familyConfidence,
          sourceMetadata: input.sourceUrl ? { sourceUrl: input.sourceUrl } : undefined,
        },
        input.sharedRegistry,
      );
      claims.push(...aggregate.claims);
      editableFields.push(...aggregate.editableFields);
      unclassified.push(...aggregate.unclassified);
      warnings.push(...aggregate.warnings);
      detectorsRun = aggregate.detectorRuns.filter((r) => r.ran).length;
    } catch (err) {
      warnings.push({
        severity: 'error',
        code: 'shared_detectors_error',
        message: `runSharedDetectors threw: ${errStr(err)}`,
      });
    }
  }

  // Step 4: Ownership resolution
  const { winners, conflicts } = resolveOwnership(claims);

  // Step 5: RegionEntry union
  const regions: RegionEntry[] = winners.map((claim) => ({
    kind: claim.regionKind,
    source: originTypeToRegionSource(claim.originType),
    ownerId: claim.ownerId,
    region: claim.region,
    instanceId: claim.scope.instanceId,
    structuralPath: claim.scope.structuralPath,
    confidence: claim.confidence,
  }));

  // Step 6: Confidence + health
  const overallConfidence = computeOverallConfidence(regions);
  const criticalRegionsHealthy = checkCriticalHealth(regions);

  // Step 7 (Fase 11.5): Image slots.
  let imageSlots: SemanticImageSlot[] = [];
  try {
    const imgResult = computeImageSlots({
      html: input.html,
      regions,
      ocrMetadata: input.ocrMetadata,
    });
    imageSlots = imgResult.slots;
  } catch (err) {
    warnings.push({
      severity: 'error',
      code: 'image_slots_error',
      message: `computeImageSlots threw: ${errStr(err)}`,
    });
  }

  // Step 8 (Fase 11.6): Text blocks.
  let textBlocks: SemanticTextBlock[] = [];
  try {
    const textResult = computeTextBlocks({
      html: input.html,
      regions,
      editableFields,
    });
    textBlocks = textResult.blocks;
  } catch (err) {
    warnings.push({
      severity: 'error',
      code: 'text_blocks_error',
      message: `computeTextBlocks threw: ${errStr(err)}`,
    });
  }

  // Emit warnings from ambiguous conflicts
  for (const c of conflicts) {
    if (c.warning) warnings.push(c.warning as AdapterWarning);
  }

  return {
    ...(input.landingPageId !== undefined ? { landingPageId: input.landingPageId } : {}),
    computedAt: input.computedAt ?? 'unknown',
    family: familyClassifier.family,
    familySource: familyClassifier.familySource,
    familyConfidence: familyClassifier.familyConfidence,
    familyClassifier,
    themeCandidates,
    components,
    regions,
    editableFields,
    imageSlots,
    textBlocks,
    unclassified,
    warnings,
    conflicts,
    overallConfidence,
    criticalRegionsHealthy,
    meta: {
      detectorsRun,
      adaptersConsulted,
      warningsCount: warnings.length,
      conflictsCount: conflicts.length,
    },
  };
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function buildComponentDetection(
  adapter: ThemeAdapter,
  candidate: AdapterCandidate,
  extraction: ExtractionResult,
): ComponentDetection {
  const bundle = extraction.regions.find((r) => r.kind === 'bundles');
  return {
    componentId: adapter.id,
    adapterId: adapter.id,
    score: candidate.score,
    overallConfidence: extraction.overallConfidence,
    bundleRegionSelector: bundle?.selector ?? null,
    cards: bundle?.children?.length ?? 0,
  };
}

function extractionRegionsToClaims(
  $: CheerioAPI,
  extraction: ExtractionResult,
  ownerId: string,
): RegionOwnershipClaim[] {
  const claims: RegionOwnershipClaim[] = [];

  for (const region of extraction.regions) {
    const scope = tryBuildScopeFromSelector($, region);
    if (!scope) continue;

    claims.push({
      ownerId,
      originType: 'component_adapter',
      regionKind: region.kind,
      scope,
      priority: 50, // DEFAULT_PRIORITY_BY_ORIGIN.component_adapter
      confidence: region.confidence,
      // Kaching é authoritative em bundles (permitido por KIND_OWNERSHIP_DEFAULTS)
      authoritative: true,
      reason: `${ownerId} extraction @ ${region.selector}`,
      region,
    });
  }
  return claims;
}

function tryBuildScopeFromSelector(
  $: CheerioAPI,
  region: SemanticRegion,
): DomScope | null {
  const el = $(region.selector).get(0);
  if (!el) return null;
  return buildDomScope($, el);
}

function originTypeToRegionSource(
  originType: 'component_adapter' | 'shared_detector' | 'page_theme_adapter',
): RegionSource {
  if (originType === 'page_theme_adapter') return 'page_theme_adapter';
  if (originType === 'component_adapter') return 'component_adapter';
  return 'shared_detector';
}

function computeOverallConfidence(regions: RegionEntry[]): number {
  if (regions.length === 0) return 0;
  const critical = regions.filter((r) =>
    (CRITICAL_REGION_KINDS as readonly SemanticRegionKind[]).includes(r.kind),
  );
  const nonCritical = regions.filter(
    (r) => !(CRITICAL_REGION_KINDS as readonly SemanticRegionKind[]).includes(r.kind),
  );
  const critWeight = 3;
  const totalWeight = critical.length * critWeight + nonCritical.length;
  if (totalWeight === 0) return 0;
  const weightedSum =
    critical.reduce((s, r) => s + r.confidence * critWeight, 0) +
    nonCritical.reduce((s, r) => s + r.confidence, 0);
  const avg = weightedSum / totalWeight;

  // A3 do ADR-002: se qualquer região crítica está unhealthy, capping.
  const CRITICAL_MIN = 0.6;
  const anyCriticalWeak = critical.some((r) => r.confidence < CRITICAL_MIN);
  if (anyCriticalWeak) {
    return Math.min(0.55, avg);
  }
  return avg;
}

function checkCriticalHealth(regions: RegionEntry[]): boolean {
  const CRITICAL_MIN = 0.6;
  const critical = regions.filter((r) =>
    (CRITICAL_REGION_KINDS as readonly SemanticRegionKind[]).includes(r.kind),
  );
  return critical.every((r) => r.confidence >= CRITICAL_MIN);
}

function emptyModelWithError(
  input: SemanticMapperInput,
  errorMsg: string,
): PageSemanticModel {
  return {
    ...(input.landingPageId !== undefined ? { landingPageId: input.landingPageId } : {}),
    computedAt: input.computedAt ?? 'unknown',
    family: 'unknown',
    familySource: 'default_unknown',
    familyConfidence: 0,
    familyClassifier: {
      family: 'unknown',
      familySource: 'default_unknown',
      familyConfidence: 0,
      familyResolution: 'unknown',
      candidates: [],
      warnings: [],
      reasons: [errorMsg],
    },
    themeCandidates: [],
    components: [],
    regions: [],
    editableFields: [],
    imageSlots: [],
    textBlocks: [],
    unclassified: [],
    warnings: [
      {
        severity: 'error',
        code: 'semantic_mapper_fatal',
        message: errorMsg,
      },
    ],
    conflicts: [],
    overallConfidence: 0,
    criticalRegionsHealthy: false,
    meta: {
      detectorsRun: 0,
      adaptersConsulted: 0,
      warningsCount: 1,
      conflictsCount: 0,
    },
  };
}

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

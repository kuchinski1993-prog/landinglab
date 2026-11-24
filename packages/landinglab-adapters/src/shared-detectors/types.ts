// ADR-002 §11.2 §1-2 — Shared detector types.

import type { CheerioAPI } from 'cheerio';
import type {
  AdapterWarning,
  UnclassifiedElement,
} from '../types/extraction.js';
import type { EditableField } from '../types/editable-field.js';
import type { PageFamily } from '../types/page-family.js';
import type { SemanticRegionKind } from '../types/semantic-region.js';
import type { RegionOwnershipClaim } from './ownership.js';

/**
 * Contexto passado pro detector. Read-only.
 * Sem DB access. Sem env. Sem network. Sem $ mutable.
 */
export interface SharedDetectorContext {
  /** HTML original. String imutável. */
  html: string;
  /**
   * Cheerio instance. Detector NÃO deve mutar. Mutations serão
   * detectadas por invariante nos testes (byte-equal check).
   */
  $: CheerioAPI;
  /** Family resolvida (user_hint OU classifier_auto OU default_unknown). */
  family: PageFamily;
  familyConfidence: number;
  /** Metadata opcional da fonte (URL etc). */
  sourceMetadata?: {
    sourceUrl?: string | null;
  };
}

/**
 * Resultado de um detector. Preserva evidence, warnings, editableFields
 * opcionais, unclassified.
 *
 * IMPORTANTE: regions[] NÃO é retornado direto — o detector emite
 * `ownershipClaims` que carregam `region` dentro. Isso força ownership
 * flow desde o começo (ver ownership.ts).
 */
export interface SharedDetectorResult {
  detectorId: string;
  ownershipClaims: RegionOwnershipClaim[];
  editableFields: EditableField[];
  unclassified: UnclassifiedElement[];
  warnings: AdapterWarning[];
  reasons: string[];
}

/**
 * Contract do detector.
 * Determinístico + read-only + never-throw pro orchestrator (orchestrator
 * isola falhas, mas detector deve tentar não lançar).
 */
export interface SharedRegionDetector {
  readonly id: string;
  readonly targetKinds: readonly SemanticRegionKind[];
  /**
   * Families onde este detector é relevante.
   * Se contexto.family não está aqui, orchestrator pode skipar (sem erro).
   * Vazio = todas as families.
   */
  readonly supportedFamilies: readonly PageFamily[];

  /**
   * Executa detecção. Retorna resultado estruturado.
   *
   * Erros lançados são capturados pelo orchestrator (runSharedDetectors) e
   * viram warning severity='error' — detector individual não quebra o pipeline.
   */
  detect(ctx: SharedDetectorContext): SharedDetectorResult;
}

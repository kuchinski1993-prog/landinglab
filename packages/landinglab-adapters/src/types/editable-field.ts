// ADR-001 §3.4 (D8 + A5) — EditableField.
// Contrato conceitual Adapter → Editor. Nenhuma UI muda nesta fase.

import type { SemanticRegionKind, Criticality } from './semantic-region.js';

export const EDITABLE_FIELD_TYPES = [
  'text',
  'price',
  'image',
  'cta_href',
  'currency',
  'bundle_ref', // Aponta pra landing_bundle_offers.id
  'variant_ref',
] as const;

export type EditableFieldType = (typeof EDITABLE_FIELD_TYPES)[number];

// A5 — onde vive o valor autoritativo deste campo.
//   canonical → source of truth em tabela (reference obrigatório)
//   html      → valor vive só no HTML (value obrigatório)
//   derived   → derivado de outro canonical (não editável direto)
export type EditableFieldSource = 'canonical' | 'html' | 'derived';

export const CANONICAL_TABLES = [
  'landing_bundle_offers',
  'landing_pages',
  'product_variants',
] as const;

export type CanonicalTable = (typeof CANONICAL_TABLES)[number];

export interface CanonicalReference {
  table: CanonicalTable;
  column: string;
  rowId?: string;
}

// O que o editor pode fazer com este campo. Adapter define o que é possível
// dado a estrutura; editor decide o que expõe ao usuário.
export const EDITABLE_CAPABILITIES = [
  'edit', // Trocar valor
  'replace', // Substituir imagem por upload
  'reorder', // Bundles reordenáveis
  'delete', // Remover oferta
  'add', // Adicionar nova oferta
  'translate', // Campo passa por i18n (Fase 11.3)
] as const;

export type EditableCapability = (typeof EDITABLE_CAPABILITIES)[number];

export interface EditableField {
  // Estável entre re-clones. Ex.: 'bundle.0.price', 'hero.headline'.
  id: string;
  region: SemanticRegionKind;
  type: EditableFieldType;
  label: string;

  // A5 — source semantics
  source: EditableFieldSource;
  criticality: Criticality;

  // Um dos dois preenchidos, conforme source:
  //   source='canonical' → reference obrigatório; value ausente
  //   source='html'      → value obrigatório; reference ausente
  //   source='derived'   → value presente (calculado); reference ausente
  value?: string | number | null;
  reference?: CanonicalReference;

  confidence: number; // 0..1
  capabilities: EditableCapability[];

  // Diagnóstico interno. Editor NUNCA usa isso pra gravar.
  selector?: string;
}

/**
 * Valida o invariante A5 do ADR-001:
 * - source=canonical → reference presente, value ausente
 * - source=html      → value presente (não undefined), reference ausente
 * - source=derived   → value presente, reference ausente
 *
 * Retorna array de violações (vazio = válido). Puro, síncrono.
 */
export function validateEditableFieldSource(field: EditableField): string[] {
  const violations: string[] = [];
  const hasValue = field.value !== undefined;
  const hasReference = field.reference !== undefined;

  switch (field.source) {
    case 'canonical':
      if (!hasReference) violations.push('source=canonical requires reference');
      if (hasValue) violations.push('source=canonical must not set value');
      break;
    case 'html':
      if (!hasValue) violations.push('source=html requires value');
      if (hasReference) violations.push('source=html must not set reference');
      break;
    case 'derived':
      if (!hasValue) violations.push('source=derived requires value');
      if (hasReference) violations.push('source=derived must not set reference');
      break;
  }

  return violations;
}

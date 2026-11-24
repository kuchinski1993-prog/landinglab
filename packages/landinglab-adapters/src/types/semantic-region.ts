// ADR-001 §3.1 + §7 (D7) — SemanticRegion.
// Kinds são enum aberto: adapters preenchem progressivamente (D1).
// Nem toda landing terá todas as regiões (Product Contract §4).

export const CRITICAL_REGION_KINDS = [
  'bundles',
  'price_block',
  'cta_primary',
  'variant_selector',
  'product_json',
  'currency_config',
] as const;

export const NON_CRITICAL_REGION_KINDS = [
  'hero',
  'product_title',
  'product_description',
  'gallery',
  'reviews',
  'testimonials',
  'benefits',
  'faq',
  'guarantee',
  'footer',
  'headline',
  'subheadline',
  'article_body',
  'author_block',
  'unclassified',
] as const;

export const SEMANTIC_REGION_KINDS = [
  ...CRITICAL_REGION_KINDS,
  ...NON_CRITICAL_REGION_KINDS,
] as const;

export type SemanticRegionKind = (typeof SEMANTIC_REGION_KINDS)[number];
export type CriticalRegionKind = (typeof CRITICAL_REGION_KINDS)[number];
export type Criticality = 'critical' | 'non_critical';

export function criticalityOf(kind: SemanticRegionKind): Criticality {
  return (CRITICAL_REGION_KINDS as readonly string[]).includes(kind)
    ? 'critical'
    : 'non_critical';
}

// Por que uma região foi classificada assim. Nunca vazio quando a região
// não é 'unclassified' — permite auditar e explicar decisões ao usuário.
export interface RegionEvidence {
  reasons: string[]; // Ex.: ['match:.kaching-bundles__bar', 'count=3']
  matchedRules: string[]; // IDs de regras internas do adapter
}

export interface SemanticRegion {
  kind: SemanticRegionKind;
  // Selector é diagnóstico interno. Editor NUNCA grava via selector (ADR §3.4).
  selector: string;
  evidence: RegionEvidence;
  confidence: number; // 0..1
  criticality: Criticality;
  // Sub-regiões estruturais opcionais (ex.: gallery → images[]).
  children?: SemanticRegion[];
}

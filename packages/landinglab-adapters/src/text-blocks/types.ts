// Fase 11.6 — Semantic text block types.
//
// Zero mutation no html_body. Blocks nascem de:
//   - Regions confirmadas (article_body, faq, footer)
//   - Shared detectors (headline, subheadline, cta_label)
//   - Existing EditableFields
//
// data-ll-block-kind NÃO é persistido — apenas runtime model.

import type { SemanticRegionKind } from '../types/semantic-region.js';

export type TextBlockKind =
  | 'headline'
  | 'subheadline'
  | 'product_title'
  | 'cta_label'
  | 'benefit_item'
  | 'faq_question'
  | 'faq_answer'
  | 'article_paragraph'
  | 'testimonial'
  | 'guarantee_text'
  | 'footer_text'
  | 'unknown';

export type TextCapability = 'edit' | 'translate';

export interface SemanticTextBlock {
  id: string; // ex.: 'article.headline' | 'faq.section.<id>.q.0' | 'cta.main.label'
  blockKind: TextBlockKind;
  content: string;
  regionKind?: SemanticRegionKind;
  index?: number;
  confidence: number;
  evidence: string[];
  structuralPath: string;
  instanceId: string;
  selector: string; // diagnóstico interno
  capabilities: readonly TextCapability[];
}

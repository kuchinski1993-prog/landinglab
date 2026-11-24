// Fase 11.5 — Image semantic slot types.
//
// Runtime model. Sem persistência. Cross-referencia com imageOcrMetadata.

import type { SemanticRegionKind } from '../types/semantic-region.js';

export type ImageSlotKind =
  | 'product_main'
  | 'gallery_image'
  | 'section_image'
  | 'advertorial_image'
  | 'logo'
  | 'decorative'
  | 'unknown';

/**
 * Evidence auxiliar do imageOcrMetadata (populado pelo worker image-metadata).
 * Passado como input ao image-slot-mapper; NUNCA acessado direto do DB.
 */
export interface ImageOcrMetadataEntry {
  url: string;
  hasText?: boolean;
  hasBrandOrigin?: boolean;
  wordCount?: number;
  ocrTextPreview?: string;
  ocrConfidence?: number;
  isRelevant?: boolean;
  /**
   * Categoria vinda do image-relevance-classifier (Gemini Vision).
   * Aux evidence — NÃO deve sozinha decidir slotKind.
   */
  category?: 'product' | 'hero' | 'copy' | 'testimonial' | 'lifestyle' | 'icon' | 'flag' | 'badge';
  bytes?: number;
}

export interface SemanticImageSlot {
  id: string; // ex.: 'product_main.0' | 'advertorial_image.0' | 'gallery_image.2'
  slotKind: ImageSlotKind;
  currentUrl: string;
  /** Onde vive no DOM. */
  structuralPath: string;
  instanceId: string;
  selector: string; // diagnóstico interno
  /** Region kind pai/contexto (se houver). */
  regionKind?: SemanticRegionKind;
  index?: number;
  confidence: number;
  evidence: string[];
  /** Metadata OCR se disponível pra URL. */
  ocrMetadata?: ImageOcrMetadataEntry;
}

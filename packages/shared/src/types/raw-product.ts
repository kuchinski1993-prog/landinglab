// Raw product types — output of the importer layers (Story 2.1).
// These represent extracted data BEFORE persistence/normalization into the
// canonical Product/ProductVariant/ProductImage rows (see ./product.ts).

export type RawProductSourceType = 'shopify_json' | 'json_ld' | 'opengraph' | 'headless';
export type RawProductExtractionLayer = 1 | 2 | 3 | 4;
export type RawProductConfidence = 'high' | 'medium' | 'low';

export interface RawVariant {
  title: string;
  price: string; // decimal string, e.g. "9.99"
  sku?: string;
  option1?: string;
  option2?: string;
  option3?: string;
  // Human-readable names of each option dimension (e.g. "Cor", "Tamanho").
  // Only populated when the source exposes them (Shopify JSON API product.options[].name).
  // Absent for other extraction layers and for products imported before this feature.
  option1Name?: string;
  option2Name?: string;
  option3Name?: string;
  // ID nativo da imagem na origem que representa esta variante (jul/2026 · Item variante↔imagem).
  // Populado pelo shopify.layer.ts a partir de variant.image_id / featured_image.id.
  // Ausente = origem não expôs (extractor não-Shopify) OU variante sem imagem específica.
  // Casado no worker contra RawImage.originId para descobrir a URL correspondente,
  // e a URL vira colorValue+isPrimaryForColor nas linhas de product_images.
  sourceImageId?: number;
}

export interface RawImage {
  src: string;
  alt?: string;
  position: number;
  // ID nativo da imagem na origem (Shopify: image.id numérico).
  // Usado para casar RawVariant.sourceImageId → esta imagem. Ausente em extractors
  // não-Shopify. NÃO persistido no banco — só serve como chave de casamento no worker.
  originId?: number;
  // Variantes desta origem que esta imagem representa (Shopify: image.variant_ids).
  // Alternativa ao sourceImageId da variante — algumas lojas populam só este lado.
  // Vazio quando origem não expõe.
  originVariantIds?: number[];
}

// Sibling product detected via swatch picker on the same page (Combined Listings pattern).
// Populated by the Shopify layer when the HTML exposes color-switcher links.
export interface SiblingInfo {
  url: string;
  handle: string;
}

export interface RawProduct {
  title: string;
  description: string; // HTML
  vendor: string;
  productType: string;
  tags: string[];
  variants: RawVariant[];
  images: RawImage[];
  sourceUrl: string;
  sourceType: RawProductSourceType;
  extractionLayer: RawProductExtractionLayer;
  confidence: RawProductConfidence;
  // Detected sibling URLs (other colors of same model). Absent when none found.
  siblings?: SiblingInfo[];
  // Moeda-base da loja de origem detectada pelo extrator (ISO 4217).
  //   - Shopify layer: fetch em {origin}/meta.json → .currency
  //   - JSON-LD layer: offer.priceCurrency
  //   - OpenGraph layer: <meta property="product:price:currency" ...>
  // Quando presente, o processor usa esta moeda em vez do sourceCurrency
  // informado manualmente pelo dono. Absent = detecção não foi possível
  // (dono precisa selecionar manualmente ou o fluxo cai no fallback).
  sourceCurrency?: string;
}

export type ImportErrorType =
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'DUPLICATE';

export interface ImportError {
  type: ImportErrorType;
  message: string;
  url?: string;
  /**
   * Story 18.11: status HTTP da origem quando houve resposta (404, 429, 503, 200 com JSON inválido…).
   * Opcional e aditivo: quem não usa ignora. O relink de cores classifica 429/5xx como transitório.
   */
  status?: number;
}

export interface DuplicateResult {
  duplicate: true;
  existingProductId: string;
}

export type ImportResult = RawProduct | RawProduct[] | ImportError | DuplicateResult;

export interface ImportOptions {
  skipLayers?: number[];
  forceLayer?: number;
  timeoutMs?: number;
}

export function isImportError(value: unknown): value is ImportError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'message' in value &&
    typeof (value as { type: unknown }).type === 'string'
  );
}

export function isDuplicateResult(value: unknown): value is DuplicateResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { duplicate?: unknown }).duplicate === true &&
    typeof (value as { existingProductId?: unknown }).existingProductId === 'string'
  );
}

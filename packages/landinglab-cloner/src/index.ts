// @blackshop/landinglab-cloner — Squad 0 (Landing Cloner) da Fase 5.
//
// Consumo:
//   import { cloneLanding } from '@blackshop/landinglab-cloner';
//   const result = await cloneLanding({
//     landingId, url, storageRoot, publicPathPrefix,
//   });
//
// Fase 5.A: literal clone (renderer + downloader + rewriter + sanitizer).
// Fase 5.B: text translator (será exportado daqui também).
// Fase 5.C: image translator (será exportado daqui também).

export {
  cloneLanding,
  assessCloneFidelity,
  extractMissingStaticScripts,
  type CloneInput,
  type CloneResult,
  type CloneProgressEvent,
  type CloneFidelityVerdict,
  type CloneFidelityResult,
  type CloneFidelityMetrics,
} from './orchestrator.js';
export { renderPage, type RenderInput, type RenderOutput } from './agents/renderer.js';
export {
  downloadAssets,
  rewriteUrls,
  type DownloadInput,
  type DownloadResult,
  type DownloadedAsset,
} from './agents/asset-downloader.js';
// Fase 5.B — tradução de texto de landings clonadas via Gemini Flash.
export {
  translateHtml,
  type TranslateInput,
  type TranslateResult,
} from './agents/text-translator.js';

// Fase 5.C — tradução de imagens (OCR + Gemini + Freepik Seedream).
export {
  translateImages,
  type ImageTranslatorInput,
  type ImageTranslatorResult,
  type ImageTranslatorProgressEvent,
  type StorageAdapter,
} from './agents/image-translator.js';
export {
  editImageWithSeedream,
  type SeedreamEditInput,
  type SeedreamEditResult,
} from './providers/freepik.js';
export {
  runOcr,
  toTesseractLang,
  terminateOcrWorkers,
  type OcrResult,
} from './providers/tesseract.js';

// CTA rewrite — detecção + reescrita de Call-To-Action links pós-clone.
export {
  extractCtas,
  rewriteCtas,
  type DetectedCta,
  type CtaCategory,
  type CtaMapping,
  type ExtractCtasOpts,
  type ExtractCtasResult,
  type RewriteCtasResult,
} from './agents/cta-detector.js';

// Product extractor — extrai título/variantes/preços/imagens do HTML clonado
// pra pré-preencher criação de produto no Shopify Admin.
export {
  extractProductFromHtml,
  type ExtractedProduct,
  type ExtractedVariant,
  type Confidence,
  type ExtractProductOpts,
} from './agents/product-extractor.js';

// Checkout handler — script inline que faz botões [data-landing-cta="buy"]
// dispararem POST /api/landing-checkout com attribution auto-coletada.
export { injectCheckoutHandler } from './agents/checkout-handler-injector.js';

// Bundle padrão LandingLab — substitui bundle da landing origem pelo template
// unificado (3 slots + highlights + toggle subs opcional). Zero interpretação
// por landing origem — o cloner emite sempre o mesmo shape controlado pelo
// wizard.
export {
  injectLandinglabBundle,
  buildLandinglabBundleHtml,
  type LandinglabBundleConfig,
  type LandinglabBundleSlot,
  type LandinglabBundleSubs,
} from './agents/landinglab-bundle-injector.js';

// Meta Pixel injector — snippet oficial + PageView + ViewContent client-side.
// Attribution auto-coletada via _fbp/_fbc cookies. Purchase é server-side (CAPI).
export { injectMetaPixel, type PixelConfig } from './agents/pixel-injector.js';

// LandingLab fixes — todos os fixes de UX/HTML que nasceram no apply-bundle.
// Idempotente por markers próprios. Reusável no preview route pra clones antigos.
export { injectLandingLabFixes, type FixesInput } from './agents/landinglab-fixes-injector.js';

// Domain suggester — gera candidatos de nome de domínio a partir do produto.
// Zero API (puro string manipulation). Backend chama Spaceship checkAvailability.
export {
  suggestDomains,
  slugifyForDomain,
  extractCoreName,
  type DomainSuggestion,
  type SuggestDomainsOpts,
} from './agents/domain-suggester.js';

// Fatia 1 do Wizard V2 — detecção automática da marca origem no clone.
// Cascata metadata → Gemini fallback. Custo ~$0-0.0002 por landing.
export { detectBrand, type BrandDetectionResult } from './agents/brand-detector.js';

// Fatia 2 do Wizard V2 — OCR metadata por imagem (pré-computado no clone).
// Usado pela etapa "Seleção de imagens" pra grid com filtros.
export {
  extractImageOcrMetadata,
  type ImageOcrMetadata,
  type ExtractImageMetadataInput,
} from './agents/image-ocr-metadata.js';

// Wizard V2 Step 4 — detecção IA-first de BUNDLES (1un/3un/6un c/ preços).
// Diferente do product-extractor (variantes Shopify), pega bundles custom
// que temas modernos (Kaching, ReCharge, etc) renderizam via markup próprio.
export {
  detectBundles,
  type DetectedBundle,
  type BundleDetectionResult,
} from './agents/bundle-detector.js';

// Skeleton Mode (SM-2.1) — extração hierárquica de landing origem em
// ExtractedSourceJson Zod-validado. Cascata Playwright → cheerio → Gemini Vision.
// Provider LLM: Gemini (não Claude, per ADDENDUM v1.2).
export {
  extractSkeleton,
  extractFromLocalHtmlFile,
  detectTheme,
  extractCheerioBase,
  ExtractedSourceJsonSchema,
  type ExtractedSourceJson,
  type SkeletonExtractInput,
  type SkeletonExtractResult,
  type SkeletonExtractRaw,
  type SkeletonExtractTrace,
  type SkeletonVisionCaller,
  type SkeletonStorageUploader,
  type ThemeFingerprint,
  type DetectedLanguage,
} from './agents/skeleton-extractor.js';

// Wizard V2 Step 2 — filtragem inteligente de imagens via Gemini Vision.
// Classifica cada imagem como relevante (product/hero/copy/testimonial) ou
// irrelevante (icon/flag/badge/background) pra evitar Wizard mostrar 300
// imagens quando só 15 fazem sentido pra rebrand.
export {
  classifyImages,
  type ImageRelevanceItem,
  type ClassifyImagesInput,
  type ClassifyImagesResult,
} from './agents/image-relevance-classifier.js';

// Skeleton Mode (SM-2.2) — extractBrand NÃO é reexportado aqui pra evitar
// side-effect: brand-extractor faz `import { fontSubstitution } from '@blackshop/db'`
// (runtime). Isso carrega db em toda rota que importa de '@blackshop/landinglab-cloner',
// e db aponta pra ./src/index.ts (TS puro) → Next fails collect-page-data.
//
// Consumers do Skeleton Mode devem importar via subpath direto:
//   import { extractBrand } from '@blackshop/landinglab-cloner/agents/brand-extractor';

// Skeleton Mode (SM-2.3) — contrast-adjuster é puro sync, sem side-effect.
export {
  adjustPaletteForWcagAA,
  type Palette,
  type AdjustmentLog,
  type ContrastAdjustInput,
  type ContrastAdjustResult,
} from './agents/contrast-adjuster.js';

// Skeleton Mode (SM-2.4) — composer usa Gemini text pra reviews IA, sem
// import db. Type-only import de render é eliminado por TSC.
export {
  composeBepurexSlots,
  type ComposeInput as SkeletonComposeInput,
  type ComposeResult as SkeletonComposeResult,
  type CopyDeckOverride,
  type VisualAssetsOverride,
  type LogoDecision,
  type DynamicExtraStatus,
  type SkeletonLanguage,
  type SkeletonId,
  type BrandLike,
} from './agents/skeleton-composer.js';

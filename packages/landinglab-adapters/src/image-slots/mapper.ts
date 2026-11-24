// Fase 11.5 — Image slot mapper.
//
// PRECISION > COVERAGE. Prefere `unknown` a slot errado.
//
// Regras fortes por slotKind:
//
//   advertorial_image:
//     - <img> dentro de scope `article_body` conhecido (region context)
//     - OU dentro de <article>
//
//   logo:
//     - <img> dentro de <header>, com alt/class mencionando "logo"
//     - OU ocrMetadata.hasBrandOrigin=true + ocrMetadata.category='badge'
//
//   product_main:
//     - Primeira <img> dentro de scope `.product-media` / `.product-gallery`
//       OU dentro de region.bundle.children (mapper cross-check)
//     - OU ocrMetadata.category='product' + está em região visual proeminente
//
//   gallery_image:
//     - <img> irmãos em cluster de mesmo container (>=3) marcados como product/lifestyle
//     - OU dentro de swiper/thumbs/gallery containers
//
//   section_image:
//     - <img> fora dos scopes acima, em section-level container
//
//   decorative:
//     - <img> com alt="" + tamanho pequeno OR class="icon" OR svg-like
//
//   unknown:
//     - Fallback quando confidence < 0.60.
//
// A5-analog: ocrMetadata sozinho NÃO promove slot. Requer DOM context.

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { buildDomScope } from '../shared-detectors/dom-scope.js';
import type { RegionEntry } from '../semantic-mapper/types.js';
import type {
  ImageOcrMetadataEntry,
  ImageSlotKind,
  SemanticImageSlot,
} from './types.js';

export interface ImageSlotMapperInput {
  html: string;
  /**
   * Regiões já resolvidas (from PageSemanticModel). Fornece contexto
   * cross-detector — ex.: article_body scope pra classificar advertorial_image.
   */
  regions?: readonly RegionEntry[];
  /**
   * OCR metadata cache (populado pelo worker). Chave normalizada por URL.
   */
  ocrMetadata?: readonly ImageOcrMetadataEntry[];
}

export interface ImageSlotMapperResult {
  slots: SemanticImageSlot[];
  slotCountByKind: Record<ImageSlotKind, number>;
  unknownCount: number;
}

export function computeImageSlots(input: ImageSlotMapperInput): ImageSlotMapperResult {
  const slotCountByKind: Record<ImageSlotKind, number> = {
    product_main: 0,
    gallery_image: 0,
    section_image: 0,
    advertorial_image: 0,
    logo: 0,
    decorative: 0,
    unknown: 0,
  };

  let $: CheerioAPI;
  try {
    $ = cheerio.load(input.html);
  } catch {
    return { slots: [], slotCountByKind, unknownCount: 0 };
  }

  const ocrByUrl = new Map<string, ImageOcrMetadataEntry>();
  if (input.ocrMetadata) {
    for (const entry of input.ocrMetadata) {
      if (entry.url) ocrByUrl.set(normalizeUrl(entry.url), entry);
    }
  }

  const articleScopes: string[] = (input.regions ?? [])
    .filter((r) => r.kind === 'article_body')
    .map((r) => r.structuralPath);

  const galleryScopes: string[] = (input.regions ?? [])
    .filter((r) => r.kind === 'gallery' || r.kind === 'bundles')
    .map((r) => r.structuralPath);

  const slots: SemanticImageSlot[] = [];
  const kindCounters: Record<ImageSlotKind, number> = {
    product_main: 0,
    gallery_image: 0,
    section_image: 0,
    advertorial_image: 0,
    logo: 0,
    decorative: 0,
    unknown: 0,
  };

  const imgs = $('img').toArray();
  for (const el of imgs) {
    const $img = $(el as never);
    const url = ($img.attr('src') ?? '').trim();
    if (!url) continue;

    const scope = buildDomScope($, el);
    const ocr = ocrByUrl.get(normalizeUrl(url));
    const decision = classifyImage($img, scope.structuralPath, {
      articleScopes,
      galleryScopes,
      ocr,
    });

    const idx = kindCounters[decision.kind]++;
    slotCountByKind[decision.kind]++;

    slots.push({
      id: `${decision.kind}.${idx}`,
      slotKind: decision.kind,
      currentUrl: url,
      structuralPath: scope.structuralPath,
      instanceId: scope.instanceId,
      selector: scope.selector,
      ...(decision.regionKind ? { regionKind: decision.regionKind } : {}),
      index: idx,
      confidence: decision.confidence,
      evidence: decision.evidence,
      ...(ocr ? { ocrMetadata: ocr } : {}),
    });
  }

  return {
    slots,
    slotCountByKind,
    unknownCount: slotCountByKind.unknown,
  };
}

// ────────────────────────────────────────────────────────────────
// Classification per image
// ────────────────────────────────────────────────────────────────

interface ClassificationOptions {
  articleScopes: string[];
  galleryScopes: string[];
  ocr?: ImageOcrMetadataEntry;
}

interface ClassificationResult {
  kind: ImageSlotKind;
  confidence: number;
  evidence: string[];
  regionKind?: 'article_body' | 'gallery' | 'bundles' | 'hero' | 'footer';
}

function classifyImage(
  $img: ReturnType<CheerioAPI>,
  structuralPath: string,
  opts: ClassificationOptions,
): ClassificationResult {
  const evidence: string[] = [];

  const alt = ($img.attr('alt') ?? '').trim();
  const cls = ($img.attr('class') ?? '').trim().toLowerCase();
  const width = parseInt(($img.attr('width') ?? '0').trim(), 10);
  const height = parseInt(($img.attr('height') ?? '0').trim(), 10);

  // logo: inside <header> + alt/class contém 'logo'; OR ocr hasBrandOrigin badge
  const inHeader = $img.closest('header').length > 0;
  const looksLikeLogo = /logo/i.test(alt) || /logo/i.test(cls);
  if (inHeader && looksLikeLogo) {
    evidence.push('logo:inside_header', 'logo:alt_or_class_logo');
    return { kind: 'logo', confidence: 0.85, evidence };
  }
  if (opts.ocr?.hasBrandOrigin === true && opts.ocr.category === 'badge') {
    evidence.push('logo:ocr_hasBrandOrigin_badge');
    return { kind: 'logo', confidence: 0.75, evidence };
  }

  // advertorial_image: dentro de article_body scope OU <article>
  const inArticleScope = opts.articleScopes.some((s) =>
    structuralPath.startsWith(s + '>'),
  );
  const inArticleTag = $img.closest('article').length > 0;
  if (inArticleScope || inArticleTag) {
    evidence.push(inArticleScope ? 'adv:in_article_scope' : 'adv:in_article_tag');
    return {
      kind: 'advertorial_image',
      confidence: 0.85,
      evidence,
      regionKind: 'article_body',
    };
  }

  // decorative: alt="" + small OR class="icon"/svg
  const isSmall = width > 0 && width <= 48 && height > 0 && height <= 48;
  const looksIcon = /icon|badge|flag/i.test(cls);
  if (alt === '' && (isSmall || looksIcon)) {
    evidence.push('decorative:alt_empty', isSmall ? 'decorative:small_size' : 'decorative:icon_class');
    return { kind: 'decorative', confidence: 0.7, evidence };
  }

  // gallery_image: dentro de gallery scope conhecido, ou container swiper/thumbs
  const inGalleryScope = opts.galleryScopes.some((s) =>
    structuralPath.startsWith(s + '>'),
  );
  const inSwiper =
    $img.closest(
      '[class*="swiper"], [class*="slick"], [class*="gallery"], [class*="carousel"], [class*="thumbs"]',
    ).length > 0;
  if (inGalleryScope || inSwiper) {
    evidence.push(inGalleryScope ? 'gallery:in_gallery_scope' : 'gallery:swiper_or_thumbs');
    return {
      kind: 'gallery_image',
      confidence: 0.75,
      evidence,
      regionKind: 'gallery',
    };
  }

  // product_main: inside product-media/product-gallery container
  const inProductMedia =
    $img.closest(
      '[class*="product-media"], [class*="product-gallery"], [class*="product__media"]',
    ).length > 0;
  if (inProductMedia) {
    evidence.push('product_main:product_media_container');
    return { kind: 'product_main', confidence: 0.75, evidence };
  }

  // OCR product category — aux evidence, precisa contexto DOM.
  // Se OCR diz product + está em <main> ou em container relevante → product_main
  if (opts.ocr?.category === 'product') {
    const inMain = $img.closest('main').length > 0;
    if (inMain) {
      evidence.push('product_main:ocr_product_in_main');
      return { kind: 'product_main', confidence: 0.65, evidence };
    }
    // OCR product mas fora de main → não promove
    evidence.push('ocr_product_but_no_dom_context');
  }

  // section_image: <img> dentro de <section> ou <main> children direct
  const inSection = $img.closest('section, main').length > 0;
  if (inSection) {
    evidence.push('section:in_section_or_main');
    return { kind: 'section_image', confidence: 0.6, evidence };
  }

  // Fallback: unknown
  evidence.push('fallback_unknown');
  return { kind: 'unknown', confidence: 0.3, evidence };
}

function normalizeUrl(u: string): string {
  return u.trim();
}

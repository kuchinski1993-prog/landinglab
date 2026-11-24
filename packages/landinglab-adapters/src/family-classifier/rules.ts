// ADR-002 §4.2 — Family classification rules.
//
// Regras heurísticas puras (sem LLM). Cada regra emite FamilyEvidence
// com family, score delta, hits e reason.
//
// A1 do ADR-002: source URL é AUXILIAR — nunca sozinha produz 'confident'.
// Peso máximo de todas as regras auxiliares combinadas é 0.05, muito abaixo
// do CLASSIFIER_MIN_CONFIDENCE (0.60).

import type { CheerioAPI } from 'cheerio';
import type { FamilyEvidence } from './types.js';

// ────────────────────────────────────────────────────────────────
// SALES PAGE signals
// ────────────────────────────────────────────────────────────────

function salesKachingMarker($: CheerioAPI): FamilyEvidence {
  const hits = $('.kaching-bundles__bar[data-deal-bar-id]').length;
  return {
    ruleId: 'sales.kaching_bundle_widget',
    family: 'sales_page',
    hits,
    scoreDelta: hits > 0 ? 0.4 : 0,
    reason:
      hits > 0
        ? `sales:.kaching-bundles__bar[data-deal-bar-id] count=${hits}`
        : 'sales:no_kaching_widget',
  };
}

function salesMultipleBundles($: CheerioAPI): FamilyEvidence {
  // >= 2 bundles é forte sinal de sales page (oferta multi-tier).
  const hits = $('.kaching-bundles__bar[data-deal-bar-id]').length;
  const disparou = hits >= 2;
  return {
    ruleId: 'sales.multi_bundle',
    family: 'sales_page',
    hits: disparou ? hits : 0,
    scoreDelta: disparou ? 0.2 : 0,
    reason: disparou
      ? `sales:multi_bundle count=${hits}`
      : `sales:insufficient_bundles count=${hits}`,
  };
}

function salesCcPdpOffer($: CheerioAPI): FamilyEvidence {
  const hits = $('button.cc-pdp-offer').length;
  return {
    ruleId: 'sales.cc_pdp_offer',
    family: 'sales_page',
    hits,
    scoreDelta: hits > 0 ? 0.3 : 0,
    reason: hits > 0 ? `sales:button.cc-pdp-offer count=${hits}` : 'sales:no_cc_pdp_offer',
  };
}

function salesMultipleCcPdpOffers($: CheerioAPI): FamilyEvidence {
  const hits = $('button.cc-pdp-offer').length;
  const disparou = hits >= 2;
  return {
    ruleId: 'sales.multi_cc_pdp_offer',
    family: 'sales_page',
    hits: disparou ? hits : 0,
    scoreDelta: disparou ? 0.2 : 0,
    reason: disparou
      ? `sales:multi_cc_pdp_offer count=${hits}`
      : `sales:insufficient_cc_pdp_offer count=${hits}`,
  };
}

function salesPriceCompareStructure($: CheerioAPI): FamilyEvidence {
  // Presence de compare-at prices em spans conhecidos (bundle ou pdp-offer).
  const hits =
    $('.kaching-bundles__bar-full-price').length +
    $('.cc-pdp-offer__compare, .cc-pdp-offer .compare').length;
  return {
    ruleId: 'sales.price_compare_structure',
    family: 'sales_page',
    hits,
    scoreDelta: hits > 0 ? 0.1 : 0,
    reason: hits > 0
      ? `sales:compare_at count=${hits}`
      : 'sales:no_compare_at_structure',
  };
}

// ────────────────────────────────────────────────────────────────
// ADVERTORIAL signals
// ────────────────────────────────────────────────────────────────

function articleTag($: CheerioAPI): FamilyEvidence {
  const hits = $('article').length;
  return {
    ruleId: 'advertorial.article_tag',
    family: 'advertorial',
    hits,
    scoreDelta: hits > 0 ? 0.2 : 0,
    reason: hits > 0 ? `advertorial:<article> count=${hits}` : 'advertorial:no_article',
  };
}

function longFormParagraphs($: CheerioAPI): FamilyEvidence {
  // 5+ <p> consecutivos dentro do maior container article/section/main.
  // Heurística: encontra o container com maior contagem de <p> filhos diretos.
  const containers = $('article, main, section, div[class*="content"]');
  let maxConsecutive = 0;
  containers.each((_, el) => {
    const paragraphCount = $(el).children('p').length;
    if (paragraphCount > maxConsecutive) maxConsecutive = paragraphCount;
  });
  const disparou = maxConsecutive >= 5;
  return {
    ruleId: 'advertorial.long_form_paragraphs',
    family: 'advertorial',
    hits: disparou ? maxConsecutive : 0,
    scoreDelta: disparou ? 0.15 : 0,
    reason: disparou
      ? `advertorial:long_form paragraphs=${maxConsecutive}`
      : `advertorial:short_form max_paragraphs=${maxConsecutive}`,
  };
}

function noCommerceMarkers($: CheerioAPI): FamilyEvidence {
  const hasKaching = $('.kaching-bundles__bar').length > 0;
  const hasShopifyAdd = $('button[name="add"]').length > 0;
  const hasCcPdp = $('.cc-pdp-offer').length > 0;
  const clean = !hasKaching && !hasShopifyAdd && !hasCcPdp;
  return {
    ruleId: 'advertorial.no_commerce_markers',
    family: 'advertorial',
    hits: clean ? 1 : 0,
    scoreDelta: clean ? 0.15 : 0,
    reason: clean
      ? 'advertorial:clean_of_commerce'
      : `advertorial:commerce_present ` +
        `kaching=${hasKaching} shopify_add=${hasShopifyAdd} cc_pdp=${hasCcPdp}`,
  };
}

function continueReadingCta($: CheerioAPI): FamilyEvidence {
  // Links externos com texto tipo "Continue reading" / "Read more" / "Click here".
  const patterns = ['continue reading', 'read more', 'click here', 'learn more', 'see full'];
  let matched = 0;
  $('a').each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (text && patterns.some((p) => text.includes(p))) matched++;
  });
  return {
    ruleId: 'advertorial.continue_cta',
    family: 'advertorial',
    hits: matched,
    scoreDelta: matched > 0 ? 0.1 : 0,
    reason: matched > 0
      ? `advertorial:continue_cta count=${matched}`
      : 'advertorial:no_continue_cta',
  };
}

// ────────────────────────────────────────────────────────────────
// PDP-DERIVED signals (A1: estruturais primários; URL apenas auxiliar)
// ────────────────────────────────────────────────────────────────

function pdpProductForm($: CheerioAPI): FamilyEvidence {
  const hits =
    $('form[action*="/cart"], form[action*="/cart/add"], form[data-product-form]').length;
  return {
    ruleId: 'pdp.product_form',
    family: 'pdp_derived',
    hits,
    scoreDelta: hits > 0 ? 0.2 : 0,
    reason: hits > 0 ? `pdp:product_form count=${hits}` : 'pdp:no_product_form',
  };
}

function pdpVariantSelector($: CheerioAPI): FamilyEvidence {
  // <select name="id"> Shopify padrão OU radio inputs com name=id em form /cart
  const hits =
    $('select[name="id"]').length +
    $('form[action*="/cart"] input[type="radio"][name="id"]').length;
  return {
    ruleId: 'pdp.variant_selector',
    family: 'pdp_derived',
    hits,
    scoreDelta: hits > 0 ? 0.2 : 0,
    reason: hits > 0
      ? `pdp:variant_selector count=${hits}`
      : 'pdp:no_variant_selector',
  };
}

function pdpMediaGallery($: CheerioAPI): FamilyEvidence {
  // Cluster de <img> em containers typic de PDP.
  const containers = $(
    '[class*="product-media"], [class*="product-gallery"], [class*="product__media"], ' +
      '[class*="swiper-product"], [class*="pdp-gallery"]',
  );
  const totalImgs = containers.find('img').length;
  const disparou = totalImgs >= 2;
  return {
    ruleId: 'pdp.media_gallery',
    family: 'pdp_derived',
    hits: disparou ? totalImgs : 0,
    scoreDelta: disparou ? 0.1 : 0,
    reason: disparou
      ? `pdp:product_media count=${totalImgs}`
      : `pdp:no_pdp_media_cluster count=${totalImgs}`,
  };
}

function pdpProductJsonBlob($: CheerioAPI): FamilyEvidence {
  // <script>...{"product":{... blob comum em PDPs Shopify. Testamos apenas
  // presença de substring — não parseamos JSON.
  let matched = 0;
  $('script').each((_, el) => {
    const text = $(el).html() ?? '';
    if (/"product"\s*:\s*\{/.test(text)) matched++;
  });
  return {
    ruleId: 'pdp.product_json_blob',
    family: 'pdp_derived',
    hits: matched,
    scoreDelta: matched > 0 ? 0.1 : 0,
    reason: matched > 0
      ? `pdp:product_json_script count=${matched}`
      : 'pdp:no_product_json_script',
  };
}

/**
 * A1 do ADR-002: URL é EVIDÊNCIA AUXILIAR.
 * Weight máximo 0.05 — nunca sozinho atinge CLASSIFIER_MIN_CONFIDENCE (0.60).
 * Marcada como `auxiliary: true`.
 */
function pdpSourceUrlHint(sourceUrl: string | null | undefined): FamilyEvidence {
  const url = (sourceUrl ?? '').trim();
  if (!url) {
    return {
      ruleId: 'pdp.source_url_hint',
      family: 'pdp_derived',
      hits: 0,
      scoreDelta: 0,
      reason: 'pdp:no_source_url',
      auxiliary: true,
    };
  }
  const matches =
    /\.myshopify\.com\/products\//i.test(url) ||
    /\/products\/[a-z0-9-]+/i.test(url);
  return {
    ruleId: 'pdp.source_url_hint',
    family: 'pdp_derived',
    hits: matches ? 1 : 0,
    scoreDelta: matches ? 0.05 : 0,
    reason: matches
      ? `pdp:source_url_shopify_pdp url=${url}`
      : `pdp:source_url_non_pdp url=${url}`,
    auxiliary: true,
  };
}

// ────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────

export type StructuralRule = (input: { $: CheerioAPI }) => FamilyEvidence;
export type UrlRule = (sourceUrl: string | null | undefined) => FamilyEvidence;

export const STRUCTURAL_RULES: readonly StructuralRule[] = [
  ({ $ }) => salesKachingMarker($),
  ({ $ }) => salesMultipleBundles($),
  ({ $ }) => salesCcPdpOffer($),
  ({ $ }) => salesMultipleCcPdpOffers($),
  ({ $ }) => salesPriceCompareStructure($),
  ({ $ }) => articleTag($),
  ({ $ }) => longFormParagraphs($),
  ({ $ }) => noCommerceMarkers($),
  ({ $ }) => continueReadingCta($),
  ({ $ }) => pdpProductForm($),
  ({ $ }) => pdpVariantSelector($),
  ({ $ }) => pdpMediaGallery($),
  ({ $ }) => pdpProductJsonBlob($),
];

export const URL_RULES: readonly UrlRule[] = [pdpSourceUrlHint];

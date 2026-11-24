// Product Extractor — extrai dados de produto do HTML clonado.
//
// Roda pós-clone/tradução pra preparar payload que vai virar produto Shopify.
// Zero custo API (parse5 + regex puros).
//
// Heurísticas (calibradas nos padrões vigoraxi + shopify DTC comuns):
//   - Título: og:title → h1 → <title>
//   - Descrição: og:description → primeiro <p> ou <div> com >150 chars no main
//   - Variantes: buttons "Comprar/Acquista/Buy X" ou selects com options price-bearing
//   - Preços: og:price:amount → schema.org Product → regex ¥/€/$/£ nos buttons
//   - Imagens: og:image → todas <img> não-logo/não-icon do body (top N)
//
// Todos os campos são "best-effort" — retorna confidence por campo.
// UI mostra pra operator revisar antes de criar no Shopify.

import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type Parse5Node = DefaultTreeAdapterMap['node'];
type Parse5Element = DefaultTreeAdapterMap['element'];
type Attribute = { name: string; value: string };

export type Confidence = 'high' | 'medium' | 'low' | 'missing';

export interface ExtractedVariant {
  /** Nome sugerido: "60 caps", "180 capsule", "3-pack", etc. */
  name: string;
  /** Preço detectado no HTML. Sempre número, moeda separada. */
  priceOriginal: number;
  /** Moeda ISO-4217 (USD, EUR, JPY, BRL). */
  currency: string;
  /** Preço comparativo (compare_at_price). Opcional. */
  compareAtOriginal?: number;
  /** SKU nunca é confiável no HTML — quase sempre vazio. */
  sku?: string;
}

export interface ExtractedProduct {
  title: string;
  titleConfidence: Confidence;
  handle: string;
  description: string;
  descriptionConfidence: Confidence;
  variants: ExtractedVariant[];
  variantsConfidence: Confidence;
  /** URLs absolutas de imagens candidatas. Ordenadas por relevância. */
  imageUrls: string[];
  imagesConfidence: Confidence;
  /** Moeda dominante detectada no HTML. */
  sourceCurrency: string;
  /** Warnings pra UI mostrar (ex: "imagens contêm texto em japonês"). */
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Regex helpers
// ─────────────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: Record<string, string> = {
  '¥': 'JPY',
  '€': 'EUR',
  '£': 'GBP',
  '$': 'USD',
  'R$': 'BRL',
  '₹': 'INR',
  '₽': 'RUB',
  '₩': 'KRW',
};

// Match: R$79,90 / €79.90 / ¥7,120 / $79 / £79.90
const PRICE_REGEX = /(R\$|[¥€£$₹₽₩])\s?(\d{1,3}(?:[,.]\d{3})*(?:[,.]\d{1,2})?)/g;

// Variant sale button — texto tipo "Acquista 3 confezione" / "Buy 2 packs"
const VARIANT_TEXT_REGEX = /\b(?:acquista|comprar|buy|compra|order|kaufen|acheter)\s+(\d+)\s*(?:x\s*)?([a-zà-ÿ]+)?/i;

// Descartar imagens que claramente não são de produto
const NON_PRODUCT_IMAGE_HINTS = /(logo|icon|sprite|favicon|payment|visa|mastercard|amex|paypal|badge|seal|flag|stripe|guarantee-seal|social|facebook|twitter|instagram)/i;

// ─────────────────────────────────────────────────────────────────────────
// Parse5 helpers
// ─────────────────────────────────────────────────────────────────────────

function isElement(node: Parse5Node): node is Parse5Element {
  const n = node as { tagName?: string; attrs?: unknown };
  if (typeof n.tagName !== 'string') return false;
  if (!Array.isArray(n.attrs)) {
    (n as { attrs: unknown[] }).attrs = [];
  }
  return true;
}

function getAttr(el: Parse5Element, name: string): string | null {
  const lower = name.toLowerCase();
  const attr = el.attrs.find((a: Attribute) => a.name.toLowerCase() === lower);
  return attr ? attr.value : null;
}

function extractText(node: Parse5Node, buf: string[] = []): string[] {
  if (node.nodeName === '#text') {
    const value = (node as unknown as { value: string }).value;
    if (value) buf.push(value);
  } else if (isElement(node)) {
    const children = node.childNodes;
    if (Array.isArray(children)) {
      for (const child of children) extractText(child, buf);
    }
  }
  return buf;
}

function textOf(node: Parse5Node): string {
  return extractText(node).join(' ').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────
// Price parsing
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse número no formato de qualquer locale:
 * "1,234.56" (US), "1.234,56" (EU), "7,120" (JP sem decimais)
 * Regra: último separador com 1-2 dígitos após = decimal. Resto = milhar.
 */
function parseLocaleNumber(raw: string): number {
  const cleaned = raw.replace(/\s/g, '');
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');

  // Só um separador
  if (lastDot === -1 && lastComma === -1) return Number.parseFloat(cleaned);
  if (lastDot === -1) {
    // Só vírgula: se últimos 3 chars têm forma ",XX" ou ",XXX" é ambíguo
    const afterComma = cleaned.length - lastComma - 1;
    if (afterComma === 2) {
      // Formato EU: "79,90" = 79.90
      return Number.parseFloat(cleaned.replace(',', '.'));
    }
    // Formato JP/US milhar: "7,120" = 7120
    return Number.parseFloat(cleaned.replace(/,/g, ''));
  }
  if (lastComma === -1) {
    // Só ponto: se últimos 3 chars têm ".XX" é decimal, senão milhar
    const afterDot = cleaned.length - lastDot - 1;
    if (afterDot === 2) return Number.parseFloat(cleaned);
    return Number.parseFloat(cleaned.replace(/\./g, ''));
  }
  // Tem os dois: o último é decimal, o outro é milhar
  if (lastDot > lastComma) {
    // "1,234.56" (US)
    return Number.parseFloat(cleaned.replace(/,/g, ''));
  }
  // "1.234,56" (EU)
  return Number.parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
}

interface ParsedPrice {
  value: number;
  currency: string;
  raw: string;
}

function extractPricesFromText(text: string): ParsedPrice[] {
  const out: ParsedPrice[] = [];
  const matches = text.matchAll(PRICE_REGEX);
  for (const m of matches) {
    const symbol = m[1];
    const numRaw = m[2];
    if (!symbol || !numRaw) continue;
    const currency = CURRENCY_SYMBOLS[symbol] ?? 'USD';
    const value = parseLocaleNumber(numRaw);
    if (Number.isFinite(value) && value > 0) {
      out.push({ value, currency, raw: m[0] });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Meta extraction (og: + schema.org)
// ─────────────────────────────────────────────────────────────────────────

interface MetaData {
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogPrice: number | null;
  ogPriceCurrency: string | null;
  productSchema: Record<string, unknown> | null;
}

function extractMeta(root: Parse5Node): MetaData {
  const meta: MetaData = {
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    ogPrice: null,
    ogPriceCurrency: null,
    productSchema: null,
  };
  const jsonLdBlocks: string[] = [];

  function walk(node: Parse5Node): void {
    if (isElement(node)) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'meta') {
        const prop = (getAttr(node, 'property') ?? getAttr(node, 'name') ?? '').toLowerCase();
        const content = getAttr(node, 'content');
        if (content) {
          if (prop === 'og:title') meta.ogTitle = content;
          else if (prop === 'og:description') meta.ogDescription = content;
          else if (prop === 'og:image' || prop === 'og:image:secure_url') {
            if (!meta.ogImage) meta.ogImage = content;
          } else if (prop === 'product:price:amount' || prop === 'og:price:amount') {
            const n = parseLocaleNumber(content);
            if (Number.isFinite(n)) meta.ogPrice = n;
          } else if (prop === 'product:price:currency' || prop === 'og:price:currency') {
            meta.ogPriceCurrency = content.toUpperCase();
          }
        }
      } else if (tag === 'script' && getAttr(node, 'type') === 'application/ld+json') {
        const inner = textOf(node);
        if (inner) jsonLdBlocks.push(inner);
      }
    }
    const children = (node as { childNodes?: Parse5Node[] }).childNodes;
    if (Array.isArray(children)) {
      for (const c of children) walk(c);
    }
  }
  walk(root);

  // Parse JSON-LD, busca Product
  for (const raw of jsonLdBlocks) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        if (typeof c !== 'object' || c === null) continue;
        const obj = c as Record<string, unknown>;
        const type = obj['@type'];
        const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
        if (isProduct) {
          meta.productSchema = obj;
          break;
        }
        // Pode estar em @graph
        const graph = obj['@graph'];
        if (Array.isArray(graph)) {
          const found = graph.find((g) => {
            if (typeof g !== 'object' || g === null) return false;
            const t = (g as Record<string, unknown>)['@type'];
            return t === 'Product' || (Array.isArray(t) && t.includes('Product'));
          });
          if (found) {
            meta.productSchema = found as Record<string, unknown>;
            break;
          }
        }
      }
      if (meta.productSchema) break;
    } catch {
      // JSON inválido, skip
    }
  }

  return meta;
}

// ─────────────────────────────────────────────────────────────────────────
// Title/description
// ─────────────────────────────────────────────────────────────────────────

function extractTitle(root: Parse5Node, meta: MetaData): { title: string; confidence: Confidence } {
  // Schema.org Product.name
  if (meta.productSchema) {
    const name = meta.productSchema['name'];
    if (typeof name === 'string' && name.trim().length > 0) {
      return { title: name.trim().slice(0, 200), confidence: 'high' };
    }
  }
  // og:title
  if (meta.ogTitle && meta.ogTitle.trim().length > 0) {
    return { title: meta.ogTitle.trim().slice(0, 200), confidence: 'high' };
  }
  // <h1> primeiro
  const h1 = findFirstElement(root, 'h1');
  if (h1) {
    const text = textOf(h1);
    if (text.length > 0) return { title: text.slice(0, 200), confidence: 'medium' };
  }
  // <title>
  const titleEl = findFirstElement(root, 'title');
  if (titleEl) {
    const text = textOf(titleEl);
    if (text.length > 0) return { title: text.slice(0, 200), confidence: 'low' };
  }
  return { title: '', confidence: 'missing' };
}

function extractDescription(root: Parse5Node, meta: MetaData): { description: string; confidence: Confidence } {
  if (meta.productSchema) {
    const desc = meta.productSchema['description'];
    if (typeof desc === 'string' && desc.trim().length > 20) {
      return { description: desc.trim().slice(0, 5000), confidence: 'high' };
    }
  }
  if (meta.ogDescription && meta.ogDescription.trim().length > 20) {
    return { description: meta.ogDescription.trim().slice(0, 5000), confidence: 'high' };
  }
  // Primeiro <p> ou <div> substancial no <main> ou <body>
  const main = findFirstElement(root, 'main') ?? findFirstElement(root, 'body');
  if (main) {
    const candidate = findFirstSubstantialText(main);
    if (candidate) return { description: candidate.slice(0, 5000), confidence: 'low' };
  }
  return { description: '', confidence: 'missing' };
}

function findFirstElement(root: Parse5Node, tagName: string): Parse5Element | null {
  const target = tagName.toLowerCase();
  let found: Parse5Element | null = null;
  function walk(node: Parse5Node): void {
    if (found) return;
    if (isElement(node)) {
      if (node.tagName.toLowerCase() === target) {
        found = node;
        return;
      }
    }
    const children = (node as { childNodes?: Parse5Node[] }).childNodes;
    if (Array.isArray(children)) {
      for (const c of children) walk(c);
    }
  }
  walk(root);
  return found;
}

function findFirstSubstantialText(root: Parse5Node): string | null {
  let found: string | null = null;
  function walk(node: Parse5Node): void {
    if (found) return;
    if (isElement(node)) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'p' || tag === 'div') {
        const text = textOf(node);
        if (text.length >= 100 && text.length <= 2000) {
          found = text;
          return;
        }
      }
    }
    const children = (node as { childNodes?: Parse5Node[] }).childNodes;
    if (Array.isArray(children)) {
      for (const c of children) walk(c);
    }
  }
  walk(root);
  return found;
}

// ─────────────────────────────────────────────────────────────────────────
// Variants
// ─────────────────────────────────────────────────────────────────────────

function extractVariants(root: Parse5Node, meta: MetaData): {
  variants: ExtractedVariant[];
  confidence: Confidence;
  dominantCurrency: string;
} {
  const variants: ExtractedVariant[] = [];
  const currencyCounts = new Map<string, number>();

  // Estratégia 1: schema.org offers
  if (meta.productSchema) {
    const offers = meta.productSchema['offers'];
    const arr = Array.isArray(offers) ? offers : offers ? [offers] : [];
    for (const off of arr) {
      if (typeof off !== 'object' || off === null) continue;
      const obj = off as Record<string, unknown>;
      const price = obj['price'];
      const currency = obj['priceCurrency'];
      const priceNum = typeof price === 'number' ? price : typeof price === 'string' ? parseLocaleNumber(price) : NaN;
      if (Number.isFinite(priceNum)) {
        const cur = typeof currency === 'string' ? currency.toUpperCase() : 'USD';
        currencyCounts.set(cur, (currencyCounts.get(cur) ?? 0) + 1);
        variants.push({
          name: typeof obj['name'] === 'string' ? (obj['name'] as string) : 'Padrão',
          priceOriginal: priceNum,
          currency: cur,
        });
      }
    }
  }

  // Estratégia 2: buttons de venda (matching regex de variante + preço)
  if (variants.length === 0) {
    const buttons = findAllElements(root, 'button');
    for (const btn of buttons) {
      const text = textOf(btn);
      if (!text) continue;
      const variantMatch = text.match(VARIANT_TEXT_REGEX);
      const prices = extractPricesFromText(text);
      if (!variantMatch || prices.length === 0) continue;
      // Extrai nome curto: "Acquista 3 confezione" → "3 confezione" (skip primeiro grupo verbo)
      const qty = variantMatch[1];
      const unit = variantMatch[2] ?? '';
      const name = `${qty} ${unit}`.trim() || text.slice(0, 60);
      // Menor preço = current price. Se tem 2, o outro é compareAt.
      const sorted = [...prices].sort((a, b) => a.value - b.value);
      const first = sorted[0];
      const second = sorted[1];
      if (!first) continue;
      currencyCounts.set(first.currency, (currencyCounts.get(first.currency) ?? 0) + 1);
      const variant: ExtractedVariant = {
        name,
        priceOriginal: first.value,
        currency: first.currency,
      };
      if (second && second.value > first.value) {
        variant.compareAtOriginal = second.value;
      }
      variants.push(variant);
    }
  }

  // Detecta moeda dominante mesmo sem variantes (pra fallback)
  if (currencyCounts.size === 0) {
    const bodyText = textOf(findFirstElement(root, 'body') ?? root);
    for (const p of extractPricesFromText(bodyText.slice(0, 5000))) {
      currencyCounts.set(p.currency, (currencyCounts.get(p.currency) ?? 0) + 1);
    }
  }

  // Dedup por nome+preço
  const seen = new Set<string>();
  const deduped = variants.filter((v) => {
    const key = `${v.name}::${v.priceOriginal}::${v.currency}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Ordena por preço asc
  deduped.sort((a, b) => a.priceOriginal - b.priceOriginal);

  const dominantCurrency = pickDominantCurrency(currencyCounts) ?? meta.ogPriceCurrency ?? 'USD';

  let confidence: Confidence = 'missing';
  if (deduped.length === 0) confidence = 'missing';
  else if (meta.productSchema && deduped.length > 0) confidence = 'high';
  else if (deduped.length >= 2) confidence = 'medium';
  else confidence = 'low';

  return { variants: deduped, confidence, dominantCurrency };
}

function pickDominantCurrency(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [cur, count] of counts) {
    if (count > bestCount) {
      best = cur;
      bestCount = count;
    }
  }
  return best;
}

function findAllElements(root: Parse5Node, tagName: string): Parse5Element[] {
  const target = tagName.toLowerCase();
  const out: Parse5Element[] = [];
  function walk(node: Parse5Node): void {
    if (isElement(node)) {
      if (node.tagName.toLowerCase() === target) out.push(node);
    }
    const children = (node as { childNodes?: Parse5Node[] }).childNodes;
    if (Array.isArray(children)) {
      for (const c of children) walk(c);
    }
  }
  walk(root);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Images
// ─────────────────────────────────────────────────────────────────────────

function extractImages(root: Parse5Node, meta: MetaData): { images: string[]; confidence: Confidence } {
  const images: string[] = [];
  const seen = new Set<string>();

  const push = (url: string): void => {
    if (!url || seen.has(url)) return;
    if (url.startsWith('data:')) return;
    if (NON_PRODUCT_IMAGE_HINTS.test(url)) return;
    seen.add(url);
    images.push(url);
  };

  // 1. og:image e schema.org Product.image (top priority)
  if (meta.ogImage) push(meta.ogImage);
  if (meta.productSchema) {
    const img = meta.productSchema['image'];
    if (typeof img === 'string') push(img);
    else if (Array.isArray(img)) {
      for (const i of img) {
        if (typeof i === 'string') push(i);
        else if (typeof i === 'object' && i !== null) {
          const url = (i as Record<string, unknown>)['url'] ?? (i as Record<string, unknown>)['contentUrl'];
          if (typeof url === 'string') push(url);
        }
      }
    }
  }

  // 2. <img> no body — top 12 não-logo/não-icon
  const imgs = findAllElements(root, 'img');
  for (const img of imgs) {
    if (images.length >= 12) break;
    const src = getAttr(img, 'src') ?? getAttr(img, 'data-src') ?? '';
    if (src) push(src);
  }

  let confidence: Confidence = 'missing';
  if (images.length === 0) confidence = 'missing';
  else if (meta.ogImage || meta.productSchema) confidence = 'high';
  else if (images.length >= 3) confidence = 'medium';
  else confidence = 'low';

  return { images: images.slice(0, 12), confidence };
}

// ─────────────────────────────────────────────────────────────────────────
// Handle (slug) generation
// ─────────────────────────────────────────────────────────────────────────

function generateHandle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'produto-clonado';
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

export interface ExtractProductOpts {
  /** URL do source pra detectar warnings (ex: domínio japonês → warn de tradução de imagem). */
  sourceUrl?: string;
}

export function extractProductFromHtml(html: string, opts: ExtractProductOpts = {}): ExtractedProduct {
  const isFullDoc = /<html/i.test(html);
  const document = isFullDoc ? parse5.parse(html) : parse5.parseFragment(html);

  const meta = extractMeta(document);
  const { title, confidence: titleConfidence } = extractTitle(document, meta);
  const { description, confidence: descriptionConfidence } = extractDescription(document, meta);
  const { variants, confidence: variantsConfidence, dominantCurrency } = extractVariants(document, meta);
  const { images, confidence: imagesConfidence } = extractImages(document, meta);

  const warnings: string[] = [];
  if (variants.length === 0) {
    warnings.push('Nenhuma variante detectada — preencha manualmente pelo menos 1 antes de criar no Shopify.');
  }
  if (images.length === 0) {
    warnings.push('Nenhuma imagem detectada — suba fotos próprias no Shopify após criar o produto.');
  }
  if (dominantCurrency === 'JPY' || dominantCurrency === 'KRW' || dominantCurrency === 'RUB') {
    warnings.push(`Moeda original é ${dominantCurrency}. Ajuste preços pra sua moeda-alvo antes de criar.`);
  }
  if (opts.sourceUrl) {
    // Heurística grosseira: domínio japonês/asiático provavelmente tem texto embutido em imagens
    const asianTLDs = /\.(jp|kr|cn|tw|hk)$/i;
    if (asianTLDs.test(new URL(opts.sourceUrl).hostname)) {
      warnings.push('Site fonte é asiático — imagens provavelmente têm texto embutido. Substitua no Shopify Admin.');
    }
  }

  return {
    title,
    titleConfidence,
    handle: generateHandle(title),
    description,
    descriptionConfidence,
    variants,
    variantsConfidence,
    imageUrls: images,
    imagesConfidence,
    sourceCurrency: dominantCurrency,
    warnings,
  };
}

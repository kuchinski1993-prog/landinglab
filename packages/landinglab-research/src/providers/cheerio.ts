// Cheerio client — provider zero-cost usado por @spec-hunter como PRIMÁRIO.
//
// Extrai identity/specs de páginas de produto via HTML parsing puro. Prioriza
// Schema.org JSON-LD (padrão Shopify/WooCommerce/DTC), depois Open Graph, com
// fallback pra HTML puro (h1/title/img/regex de preço).
//
// Zero HTTP cost, zero API key. Latency típica: 300-1500ms (só fetch + parse).
//
// Referência: refactor spec-hunter (2026-09-04) — Firecrawl vira fallback.

import * as cheerio from 'cheerio';

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_HTML_BYTES = 500;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export type CheerioSource = 'json-ld' | 'open-graph' | 'html-fallback' | 'mixed';
export type CheerioStatus = 'ok' | 'partial' | 'failed';

export interface CheerioIdentity {
  name: string | null;
  brand: string | null;
  price: number | null;
  currency: string | null;
  images: string[];
  description: string | null;
  category: string | null;
}

export interface CheerioExtractResult {
  status: CheerioStatus;
  identity: CheerioIdentity;
  specs: Record<string, string | number>;
  source: CheerioSource;
  cost_usd: 0;
  latency_ms: number;
  /** Optional debug info: HTTP status, reason if failed. */
  error?: string;
}

export interface CheerioExtractOpts {
  timeoutMs?: number;
  /** Injectable fetch para testes (default: global fetch). */
  fetchImpl?: typeof fetch;
}

export interface CheerioClient {
  extractFromUrl(url: string, opts?: CheerioExtractOpts): Promise<CheerioExtractResult>;
}

// ─────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────

export function createCheerioClient(): CheerioClient {
  return {
    async extractFromUrl(url, opts) {
      const started = Date.now();
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const fetchImpl = opts?.fetchImpl ?? fetch;

      // ─── Etapa A: fetch HTML ─────────────────────────────────────────
      let html: string;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchImpl(url, {
            method: 'GET',
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: controller.signal,
          });
          if (!res.ok) {
            return failed(started, `http_${res.status}`);
          }
          const contentType = res.headers.get('content-type') ?? '';
          if (!contentType.toLowerCase().includes('text/html')) {
            return failed(started, `non_html_content_type:${contentType}`);
          }
          html = await res.text();
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failed(started, `fetch_error:${msg}`);
      }

      if (html.length < MIN_HTML_BYTES) {
        return failed(started, `html_too_small:${html.length}b`);
      }

      // ─── Etapa B: parse ─────────────────────────────────────────────
      const $ = cheerio.load(html);

      // ─── Etapa C: JSON-LD (fonte MAIS confiável) ────────────────────
      const jsonLdProduct = extractJsonLdProduct($);

      // ─── Etapa D: Open Graph fallback ───────────────────────────────
      const og = extractOpenGraph($);

      // ─── Etapa E: HTML puro fallback ────────────────────────────────
      const htmlFallback = extractHtmlFallback($, html);

      // ─── Etapa F: merge estratégico ─────────────────────────────────
      const { identity, specs, source, status } = mergeSources(jsonLdProduct, og, htmlFallback);

      return {
        status,
        identity,
        specs,
        source,
        cost_usd: 0,
        latency_ms: Date.now() - started,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// JSON-LD extraction (Schema.org Product)
// ─────────────────────────────────────────────────────────────────────────

interface JsonLdProductPartial {
  name: string | null;
  brand: string | null;
  price: number | null;
  currency: string | null;
  images: string[];
  description: string | null;
  category: string | null;
  specs: Record<string, string | number>;
}

function extractJsonLdProduct($: cheerio.CheerioAPI): JsonLdProductPartial | null {
  const scripts = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).html())
    .get()
    .filter((s): s is string => !!s && s.trim().length > 0);

  const candidates: unknown[] = [];
  for (const raw of scripts) {
    try {
      const parsed = JSON.parse(raw);
      // Pode ser array (Shopify comum) ou objeto único ou @graph.
      if (Array.isArray(parsed)) {
        candidates.push(...parsed);
      } else if (isObject(parsed) && Array.isArray(parsed['@graph'])) {
        candidates.push(...parsed['@graph']);
      } else {
        candidates.push(parsed);
      }
    } catch {
      // Ignora scripts inválidos silenciosamente — HTML no wild é bagunçado.
    }
  }

  // Prioriza @type === 'Product'. Aceita string OU array de types.
  const product = candidates.find((c) => {
    if (!isObject(c)) return false;
    const t = c['@type'];
    if (typeof t === 'string') return t === 'Product';
    if (Array.isArray(t)) return t.includes('Product');
    return false;
  });

  if (!isObject(product)) return null;

  const name = strOrNull(product['name']);
  const description = strOrNull(product['description']);
  const category = strOrNull(product['category']);

  // brand pode ser: string, { name: string }, ou { "@type": "Brand", name: string }
  let brand: string | null = null;
  const rawBrand = product['brand'];
  if (typeof rawBrand === 'string') brand = rawBrand;
  else if (isObject(rawBrand)) brand = strOrNull(rawBrand['name']);

  // image pode ser string, array de strings, ou objeto { url }
  const images = normalizeImages(product['image']);

  // offers: Offer | AggregateOffer | array
  const { price, currency } = extractPriceFromOffers(product['offers']);

  // additionalProperty: array de PropertyValue { name, value }
  const specs = extractSpecsFromProduct(product);

  return { name, brand, price, currency, images, description, category, specs };
}

function extractPriceFromOffers(offers: unknown): { price: number | null; currency: string | null } {
  if (!offers) return { price: null, currency: null };
  const candidates: unknown[] = Array.isArray(offers) ? offers : [offers];
  for (const off of candidates) {
    if (!isObject(off)) continue;
    // AggregateOffer usa lowPrice; Offer usa price.
    const p = off['price'] ?? off['lowPrice'] ?? off['highPrice'];
    const c = off['priceCurrency'];
    const price = toNumber(p);
    const currency = typeof c === 'string' ? c.toUpperCase() : null;
    if (price !== null || currency !== null) return { price, currency };
    // Alguns Shopify aninham em priceSpecification.
    const spec = off['priceSpecification'];
    if (isObject(spec)) {
      const sp = toNumber(spec['price']);
      const sc = typeof spec['priceCurrency'] === 'string' ? String(spec['priceCurrency']).toUpperCase() : null;
      if (sp !== null || sc !== null) return { price: sp, currency: sc };
    }
  }
  return { price: null, currency: null };
}

function extractSpecsFromProduct(product: Record<string, unknown>): Record<string, string | number> {
  const specs: Record<string, string | number> = {};
  const props = product['additionalProperty'];
  if (Array.isArray(props)) {
    for (const p of props) {
      if (!isObject(p)) continue;
      const n = strOrNull(p['name']);
      const v = p['value'];
      if (n && (typeof v === 'string' || typeof v === 'number')) {
        specs[n] = v;
      }
    }
  }
  // Campos escalares comuns que valem incluir em specs.
  const sku = strOrNull(product['sku']);
  if (sku) specs['sku'] = sku;
  const gtin = strOrNull(product['gtin13'] ?? product['gtin']);
  if (gtin) specs['gtin'] = gtin;
  return specs;
}

// ─────────────────────────────────────────────────────────────────────────
// Open Graph extraction
// ─────────────────────────────────────────────────────────────────────────

interface OpenGraphPartial {
  name: string | null;
  price: number | null;
  currency: string | null;
  images: string[];
  description: string | null;
  brand: string | null;
}

function extractOpenGraph($: cheerio.CheerioAPI): OpenGraphPartial | null {
  const ogTitle = $('meta[property="og:title"]').attr('content') ?? null;
  const ogImage = $('meta[property="og:image"]').attr('content') ?? null;
  const ogImageSecondary = $('meta[property="og:image:secure_url"]').attr('content') ?? null;
  const ogDescription = $('meta[property="og:description"]').attr('content') ?? null;
  const productPrice = $('meta[property="product:price:amount"]').attr('content') ?? null;
  const productCurrency = $('meta[property="product:price:currency"]').attr('content') ?? null;
  const ogBrand =
    $('meta[property="product:brand"]').attr('content') ??
    $('meta[property="og:brand"]').attr('content') ??
    null;

  const anyMeaningful = ogTitle || ogImage || ogDescription || productPrice;
  if (!anyMeaningful) return null;

  const images: string[] = [];
  if (ogImage) images.push(ogImage);
  if (ogImageSecondary && ogImageSecondary !== ogImage) images.push(ogImageSecondary);

  return {
    name: ogTitle,
    price: toNumber(productPrice),
    currency: productCurrency ? productCurrency.toUpperCase() : null,
    images,
    description: ogDescription,
    brand: ogBrand,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// HTML fallback (last resort)
// ─────────────────────────────────────────────────────────────────────────

interface HtmlFallbackPartial {
  name: string | null;
  price: number | null;
  currency: string | null;
  images: string[];
}

function extractHtmlFallback($: cheerio.CheerioAPI, rawHtml: string): HtmlFallbackPartial {
  const h1 = $('h1').first().text().trim();
  const title = $('title').first().text().trim();
  const name = h1 || title || null;

  // Imagens: primeiras 5 com src razoável (não data-uri, não ícone).
  const images: string[] = [];
  $('img').each((_, el) => {
    if (images.length >= 5) return;
    const src = $(el).attr('src') ?? $(el).attr('data-src') ?? '';
    if (!src) return;
    if (src.startsWith('data:')) return;
    if (/(icon|logo|sprite|favicon)/i.test(src)) return;
    images.push(src);
  });

  // Preço: regex sobre HTML puro. Aceita $, €, £, R$.
  const priceRegex = /(?:\$|€|£|R\$)\s?(\d{1,4}(?:[.,]\d{2})?)/;
  const match = rawHtml.match(priceRegex);
  let price: number | null = null;
  let currency: string | null = null;
  if (match?.[1]) {
    price = toNumber(match[1].replace(',', '.'));
    const symbol = match[0].trim()[0];
    currency = symbol === '$' ? 'USD' : symbol === '€' ? 'EUR' : symbol === '£' ? 'GBP' : symbol === 'R' ? 'BRL' : null;
  }

  return { name, price, currency, images };
}

// ─────────────────────────────────────────────────────────────────────────
// Merge sources (JSON-LD > OG > HTML fallback)
// ─────────────────────────────────────────────────────────────────────────

interface MergeResult {
  identity: CheerioIdentity;
  specs: Record<string, string | number>;
  source: CheerioSource;
  status: CheerioStatus;
}

function mergeSources(
  jsonLd: JsonLdProductPartial | null,
  og: OpenGraphPartial | null,
  html: HtmlFallbackPartial,
): MergeResult {
  const sourcesUsed: Set<CheerioSource> = new Set();

  const pick = <T>(a: T | null | undefined, b: T | null | undefined, c: T | null | undefined, src: {
    a: CheerioSource; b: CheerioSource; c: CheerioSource;
  }): T | null => {
    if (a != null && a !== ('' as unknown as T)) { sourcesUsed.add(src.a); return a; }
    if (b != null && b !== ('' as unknown as T)) { sourcesUsed.add(src.b); return b; }
    if (c != null && c !== ('' as unknown as T)) { sourcesUsed.add(src.c); return c; }
    return null;
  };

  const name = pick(jsonLd?.name, og?.name, html.name, { a: 'json-ld', b: 'open-graph', c: 'html-fallback' });
  const brand = pick(jsonLd?.brand, og?.brand, null, { a: 'json-ld', b: 'open-graph', c: 'html-fallback' });
  const price = pick(jsonLd?.price, og?.price, html.price, { a: 'json-ld', b: 'open-graph', c: 'html-fallback' });
  const currency = pick(jsonLd?.currency, og?.currency, html.currency, { a: 'json-ld', b: 'open-graph', c: 'html-fallback' });
  const description = pick(jsonLd?.description, og?.description, null, { a: 'json-ld', b: 'open-graph', c: 'html-fallback' });
  const category = jsonLd?.category ?? null;
  if (category) sourcesUsed.add('json-ld');

  // Merge images: prioriza JSON-LD, complementa com OG e HTML (dedup, max 8).
  const imgSet = new Set<string>();
  if (jsonLd?.images) { for (const i of jsonLd.images) imgSet.add(i); if (jsonLd.images.length) sourcesUsed.add('json-ld'); }
  if (og?.images) { for (const i of og.images) imgSet.add(i); if (og.images.length) sourcesUsed.add('open-graph'); }
  for (const i of html.images) { if (imgSet.size >= 8) break; imgSet.add(i); }
  if (html.images.length && imgSet.size > (jsonLd?.images?.length ?? 0) + (og?.images?.length ?? 0)) {
    sourcesUsed.add('html-fallback');
  }
  const images = Array.from(imgSet).slice(0, 8);

  const specs = jsonLd?.specs ?? {};

  // Source aggregate
  let source: CheerioSource;
  if (sourcesUsed.size === 0) source = 'html-fallback';
  else if (sourcesUsed.size === 1) source = Array.from(sourcesUsed)[0]!;
  else source = 'mixed';

  // Status: 'ok' se temos name + (price OU images significativas).
  // 'partial' se só temos name. 'failed' se nem name.
  let status: CheerioStatus;
  if (!name) {
    status = 'failed';
  } else if (price !== null || images.length > 0) {
    status = 'ok';
  } else {
    status = 'partial';
  }

  return {
    identity: { name, brand, price, currency, images, description, category },
    specs,
    source,
    status,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function failed(started: number, reason: string): CheerioExtractResult {
  return {
    status: 'failed',
    identity: {
      name: null,
      brand: null,
      price: null,
      currency: null,
      images: [],
      description: null,
      category: null,
    },
    specs: {},
    source: 'html-fallback',
    cost_usd: 0,
    latency_ms: Date.now() - started,
    error: reason,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeImages(img: unknown): string[] {
  if (!img) return [];
  const out: string[] = [];
  const push = (candidate: unknown): void => {
    if (typeof candidate === 'string' && candidate.length > 0) out.push(candidate);
    else if (isObject(candidate)) {
      const url = candidate['url'] ?? candidate['contentUrl'];
      if (typeof url === 'string' && url.length > 0) out.push(url);
    }
  };
  if (Array.isArray(img)) {
    for (const i of img) push(i);
  } else {
    push(img);
  }
  return out.slice(0, 8);
}

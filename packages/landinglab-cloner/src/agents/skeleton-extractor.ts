// skeleton-extractor — SM-2.1
//
// Entrada do pipeline Skeleton Mode. Recebe URL (ou HTML override FR-30) e
// retorna `ExtractedSourceJson` Zod-validado + raw HTML + screenshot path +
// theme fingerprint + trace.
//
// Estratégia híbrida em cascata (ADR-9 revisado por ADDENDUM v1.2):
//   1. Playwright (renderer.ts REUSA) → HTML pós-render + screenshot
//   2. Cheerio determinístico → copy, imagery, commerce (preços, bundles,
//      FAQ, reviews) via seletores CSS de temas conhecidos + regex.
//   3. Gemini Vision Pro (providers/gemini-vision REUSA) → hero image,
//      dynamic_extras verdicts, detected_language (quando <html lang> falha).
//   4. Fallback: 1 retry backoff exponencial em erro Vision. Se ainda
//      falhar → modo degradado (`meta.partial: true`, `degradedFields`
//      populado, JSON cheerio parcial). NUNCA trava pipeline.
//
// Provider LLM: Gemini (não Claude Opus). Story ADDENDUM v1.2. Custo ~$0.01/call
// (Gemini Vision Flash) vs $0.023 (Opus). REUSA `callGeminiVision` já
// implementado no pacote (providers/gemini-vision.ts) — mas com wrapper local
// que bypassa o guard `USE_GEMINI_VISION_CLASSIFIER=1` (que era pra o
// image-classifier de 200-300 imagens/landing). Aqui rodamos 1x por landing.

import { promises as fs } from 'node:fs';

import * as cheerio from 'cheerio';

import { renderPage, type RenderOutput } from './renderer.js';
import {
  ExtractedSourceJsonSchema,
  type ExtractedSourceJson,
  type SkeletonExtractInput,
  type SkeletonExtractResult,
  type SkeletonExtractTrace,
  type SkeletonVisionCaller,
  type ThemeFingerprint,
  type DetectedLanguage,
} from './skeleton-extractor.types.js';

// Re-exporta pra consumidores importarem tudo daqui (skeleton-composer SM-2.4).
export * from './skeleton-extractor.types.js';

const BUCKET_NAME = 'skeleton-source-snapshots';
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024; // NFR-3: ≤5MB
const VISION_TIMEOUT_MS = 45_000;
const VISION_MAX_RETRIES = 2; // 1 primary + 1 backoff (per ADDENDUM v1.2)
const VISION_RETRY_BASE_MS = 1_000; // 1s → 2s

// ─── Public API (AC1/AC2/AC3) ────────────────────────────────────────────────

export async function extractSkeleton(
  input: SkeletonExtractInput,
): Promise<SkeletonExtractResult> {
  const trace: SkeletonExtractTrace[] = [];
  const degradedFields: string[] = [];

  // Step 1: obter HTML + screenshot
  const rendered = await stepRender(input, trace);

  // Step 2: theme fingerprint (rápido, purely cheerio)
  const themeFingerprint = detectTheme(rendered.html);
  trace.push({
    step: 'theme-fingerprint',
    latencyMs: 0,
    provider: 'cheerio',
    notes: themeFingerprint,
  });

  // Step 3: cheerio determinístico → base JSON
  const cheerioStart = Date.now();
  const base = extractCheerioBase(rendered.html, themeFingerprint);
  trace.push({
    step: 'cheerio-extract',
    latencyMs: Date.now() - cheerioStart,
    provider: 'cheerio',
    notes: `${base.copy.faq.length} faq · ${base.commerce.reviews.length} reviews · ${base.commerce.bundles.length} bundles`,
  });

  // Step 4: Vision (opcional) enriquece hero_url + dynamic_extras + language
  let visionEnrichment: VisionEnrichment | null = null;
  if (!input.disableVision && rendered.screenshotBytes) {
    visionEnrichment = await stepVision(
      rendered.screenshotBytes,
      base,
      themeFingerprint,
      trace,
      input.visionCaller,
    );
    if (!visionEnrichment) {
      degradedFields.push('vision.hero_url', 'vision.dynamic_extras_verdict');
    }
  } else if (input.disableVision) {
    trace.push({
      step: 'vision-skipped',
      latencyMs: 0,
      provider: 'vision-gemini',
      notes: 'disableVision=true',
    });
    degradedFields.push('vision.hero_url', 'vision.dynamic_extras_verdict');
  }

  // Merge visionEnrichment into base
  const merged = mergeVisionIntoBase(base, visionEnrichment);

  // Step 5: language final (html lang > meta > vision)
  const detectedLanguage = pickDetectedLanguage(
    rendered.detectedLanguageRaw,
    visionEnrichment?.detected_language ?? null,
  );
  merged.meta.detected_language = detectedLanguage;

  // Step 6: partial verdict
  merged.meta.partial = degradedFields.length > 0;
  merged.meta.unresolved_fields = degradedFields;

  // Step 7: Upload screenshot (best-effort). Só marca degradado se caller
  // configurou storageUploader e ele falhou — ausência de uploader é config
  // válida (usada em testes, htmlOverride e execução em modo dev).
  const uploadStart = Date.now();
  const screenshotPath = await stepUploadScreenshot(
    rendered.screenshotBytes,
    input,
    trace,
  );
  if (
    screenshotPath === '' &&
    rendered.screenshotBytes &&
    input.storageUploader !== undefined
  ) {
    degradedFields.push('storage.screenshot');
    merged.meta.partial = true;
    merged.meta.unresolved_fields = degradedFields;
  }
  trace.push({
    step: 'storage-upload',
    latencyMs: Date.now() - uploadStart,
    provider: 'storage',
    notes: screenshotPath || (input.storageUploader ? 'failed' : 'no-uploader-configured'),
  });

  // Step 8: Validate against schema (AC4)
  const validationStart = Date.now();
  const parsed = ExtractedSourceJsonSchema.safeParse(merged);
  trace.push({
    step: 'zod-validate',
    latencyMs: Date.now() - validationStart,
    provider: 'validation',
    notes: parsed.success ? 'ok' : parsed.error.errors.length + ' issues',
  });
  if (!parsed.success) {
    // Falha de schema é bug interno — logamos e devolvemos o merged bruto
    // (não travamos pipeline conforme mandato). Consumidor pode inspecionar.
    // Coalescemos pra base parcial + marcamos partial=true.
    const fixed: ExtractedSourceJson = {
      ...merged,
      meta: {
        ...merged.meta,
        partial: true,
        unresolved_fields: [...merged.meta.unresolved_fields, 'schema.validation'],
      },
    };
    return {
      raw: {
        html: rendered.html,
        screenshotPath,
        finalUrl: rendered.finalUrl,
        detectedLanguage,
      },
      extracted: fixed,
      degradedFields: [...degradedFields, 'schema.validation'],
      themeFingerprint,
      trace,
    };
  }

  return {
    raw: {
      html: rendered.html,
      screenshotPath,
      finalUrl: rendered.finalUrl,
      detectedLanguage,
    },
    extracted: parsed.data,
    degradedFields,
    themeFingerprint,
    trace,
  };
}

// ─── Step 1: Render (Playwright reused OR htmlOverride) ──────────────────────

interface RenderedPayload {
  html: string;
  finalUrl: string;
  detectedLanguageRaw: string | null;
  screenshotBytes: Buffer | null;
}

async function stepRender(
  input: SkeletonExtractInput,
  trace: SkeletonExtractTrace[],
): Promise<RenderedPayload> {
  const started = Date.now();
  if (input.htmlOverride) {
    // FR-30: paste manual. Não roda Playwright — usa screenshotOverride se
    // veio, senão fica null (Vision path pode ser skipado).
    trace.push({
      step: 'render-override',
      latencyMs: Date.now() - started,
      provider: 'playwright',
      notes: `htmlOverride (${input.htmlOverride.length} chars)`,
    });
    const lang = pickLangFromRawHtml(input.htmlOverride);
    const bytes = input.screenshotOverride ?? null;
    return {
      html: input.htmlOverride,
      finalUrl: input.url,
      detectedLanguageRaw: lang,
      screenshotBytes: bytes ? capBytes(bytes) : null,
    };
  }

  // URL mode: Playwright renderiza + captura screenshot
  const rendered: RenderOutput = await renderPage({ url: input.url });
  const screenshot = await captureScreenshotSafe(input.url);
  trace.push({
    step: 'render-playwright',
    latencyMs: Date.now() - started,
    provider: 'playwright',
    notes: `${rendered.bytes} bytes html · ${screenshot ? screenshot.length : 0} bytes shot`,
  });
  return {
    html: rendered.html,
    finalUrl: rendered.finalUrl,
    detectedLanguageRaw: rendered.detectedLanguage,
    screenshotBytes: screenshot ? capBytes(screenshot) : null,
  };
}

/** Captura screenshot separada — abre nova página (custo baixo) pra viewport 1440x2000 full page.
 * Isola de renderPage pra evitar mudar assinatura pública. Falha silenciosa: retorna null. */
async function captureScreenshotSafe(url: string): Promise<Buffer | null> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
      // Screenshot full page — Vision precisa ver seções extras abaixo do fold.
      // JPEG @ 75q pra ficar sob NFR-3 (5MB) na maioria dos casos.
      const bytes = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: true });
      return bytes;
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}

function capBytes(buf: Buffer): Buffer {
  if (buf.length <= MAX_SCREENSHOT_BYTES) return buf;
  // Truncar seria corromper PNG/JPEG. Retornamos null-ish sinalização: mantém
  // buffer mas Vision path deve degradar. Aqui só logamos via caller.
  return buf; // Caller decide degradar (Vision recusa >5MB).
}

// ─── Step 2: Theme fingerprint (AC6) ─────────────────────────────────────────

export function detectTheme(html: string): ThemeFingerprint {
  const lower = html.toLowerCase();
  // Ordem importa — Kaching pode coexistir com temas, mas o marker próprio
  // é o mais específico. Aurivita e Bepurex são temas Kaching-based, mas
  // usam classes próprias (`.aurivita-*`, `.cc-*`).
  if (/\baurivita[-_]?[a-z0-9]*/i.test(lower)) return 'aurivita';
  if (/\bcc-(pdp|advertorial|timeline|doctors-see|review-card|faq__item|guarantee)/i.test(lower)) {
    return 'bepurex';
  }
  if (/\bkaching[-_](bundles|theme)/i.test(lower)) return 'kaching';
  if (
    /cdn\.shopify\.com/i.test(lower) ||
    /shopify\.load-feature|shopify\.designMode/i.test(lower) ||
    /template-product|shopify-section/i.test(lower)
  ) {
    return 'shopify-default';
  }
  return 'unknown';
}

// ─── Step 3: Cheerio extraction (AC5) ────────────────────────────────────────

export function extractCheerioBase(
  html: string,
  theme: ThemeFingerprint,
): ExtractedSourceJson {
  const $ = cheerio.load(html);

  const copy = extractCopy($, theme);
  const imagery = extractImagery($, theme);
  const brand = extractBrandHints($);
  const commerce = extractCommerce($, theme);

  return {
    copy,
    imagery,
    brand,
    commerce,
    dynamic_extras: [], // Preenchido pela Vision (verdict + heading)
    meta: {
      partial: false,
      unresolved_fields: [],
      detected_language: null,
    },
  };
}

function extractCopy(
  $: cheerio.CheerioAPI,
  _theme: ThemeFingerprint,
): ExtractedSourceJson['copy'] {
  const headline = firstNonEmpty([
    $('h1.cc-pdp__title').first().text(),
    $('h1.cc-hero__headline').first().text(),
    $('.product-hero__title').first().text(),
    $('h1').first().text(),
    $('meta[property="og:title"]').attr('content') ?? '',
    $('title').text(),
  ]);

  const subhead = firstNonEmpty([
    $('.cc-pdp__subtitle').first().text(),
    $('.cc-hero__subhead').first().text(),
    $('.product-hero__subtitle').first().text(),
    $('meta[name="description"]').attr('content') ?? '',
  ]);

  const benefit_bullets = collectBullets($);
  const faq = collectFaq($);
  const testimonials = collectReviews($, /* asTestimonial */ true);

  return {
    hero_headline: headline || 'Untitled',
    ...(subhead ? { hero_subhead: subhead } : {}),
    benefit_bullets,
    faq,
    testimonials,
  };
}

function collectBullets($: cheerio.CheerioAPI): string[] {
  const bullets = new Set<string>();
  const selectors = [
    '.cc-bullets__item',
    '.cc-benefits li',
    '.benefits__list li',
    '.benefits li',
    'ul.benefits li',
  ];
  for (const sel of selectors) {
    $(sel).each((_i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 3 && text.length < 200) bullets.add(text);
    });
    if (bullets.size >= 4) break;
  }
  return Array.from(bullets);
}

function collectFaq($: cheerio.CheerioAPI): ExtractedSourceJson['copy']['faq'] {
  const items: ExtractedSourceJson['copy']['faq'] = [];
  // 1. <details><summary>...</summary><...>answer</...></details>
  $('details').each((_i, el) => {
    const $el = $(el);
    const q = $el.find('summary').first().text().trim();
    // Answer = tudo dentro do <details> exceto <summary>
    const $clone = $el.clone();
    $clone.find('summary').remove();
    const a = $clone.text().trim().replace(/\s+/g, ' ');
    if (q && a) items.push({ q, a });
  });
  // 2. .cc-faq__item (bepurex custom accordion)
  $('.cc-faq__item').each((_i, el) => {
    const $el = $(el);
    if ($el.is('details')) return; // já capturado acima
    const q = $el.find('summary, .cc-faq__question, h3').first().text().trim();
    const a = $el.find('.cc-faq__answer, .cc-faq__body, p').first().text().trim();
    if (q && a) items.push({ q, a });
  });
  return items;
}

function collectReviews(
  $: cheerio.CheerioAPI,
  asTestimonial: boolean,
): ExtractedSourceJson['copy']['testimonials'] {
  const items: ExtractedSourceJson['copy']['testimonials'] = [];
  const selectors = ['.cc-review-card', '.spr-review'];
  for (const sel of selectors) {
    $(sel).each((_i, el) => {
      const $el = $(el);
      const content = firstNonEmpty([
        $el.find('.cc-review-card__body').text(),
        $el.find('.spr-review-content-body').text(),
        $el.find('p').first().text(),
      ]).trim();
      const author = firstNonEmpty([
        $el.find('.cc-review-card__author').text(),
        $el.find('.spr-review-header-byline').text(),
        $el.find('footer').text(),
      ]).trim();
      if (content && author) items.push({ author, content });
    });
    if (items.length > 0) break; // não misturar temas
  }
  // asTestimonial=true → primeira metade vira "testimonials", resto fica pra reviews
  return asTestimonial ? items.slice(0, Math.max(2, Math.floor(items.length / 2))) : items;
}

function extractImagery(
  $: cheerio.CheerioAPI,
  _theme: ThemeFingerprint,
): ExtractedSourceJson['imagery'] {
  const heroCandidates = [
    $('.cc-pdp__main img').first().attr('src'),
    $('.cc-hero__media img').first().attr('src'),
    $('.product-hero__gallery img').first().attr('src'),
    $('meta[property="og:image"]').attr('content'),
    $('img').first().attr('src'),
  ].filter((s): s is string => !!s && s.length > 0);
  const hero_url = heroCandidates[0] ?? null;

  const galleryUrls = new Set<string>();
  const gallerySelectors = [
    '.cc-pdp__thumbs img',
    '.product-hero__thumbs img',
    '.cc-timeline__media img',
  ];
  for (const sel of gallerySelectors) {
    $(sel).each((_i, el) => {
      const src = $(el).attr('src');
      if (src && src !== hero_url) galleryUrls.add(src);
    });
  }

  const lifestyleUrls = new Set<string>();
  $('.cc-cis__image img, .cc-expert-quote__image img').each((_i, el) => {
    const src = $(el).attr('src');
    if (src) lifestyleUrls.add(src);
  });

  // Logo: <img> com src|alt|class contendo "logo" OR dentro de <header>
  let logoUrl: string | null = null;
  const logoCandidates = [
    $('header img[src*="logo" i]').first().attr('src'),
    $('img[alt*="logo" i]').first().attr('src'),
    $('.cc-header__logo img').first().attr('src'),
    $('.site-header__logo img').first().attr('src'),
    $('.logo img, .site-logo img').first().attr('src'),
    $('header img').first().attr('src'),
  ];
  for (const url of logoCandidates) {
    if (url && url.length > 0) {
      logoUrl = url;
      break;
    }
  }

  return {
    hero_url,
    gallery_urls: Array.from(galleryUrls),
    lifestyle_urls: Array.from(lifestyleUrls),
    logo_url: logoUrl,
  };
}

function extractBrandHints(
  $: cheerio.CheerioAPI,
): ExtractedSourceJson['brand'] {
  // Hints leves — brand-extractor (SM-2.2) faz o trabalho pesado.
  const colors = new Set<string>();
  const fonts = new Set<string>();
  $('[style]').each((_i, el) => {
    const style = $(el).attr('style') ?? '';
    const hexMatches = style.match(/#[0-9a-f]{3,8}\b/gi);
    if (hexMatches) hexMatches.forEach((h) => colors.add(h.toLowerCase()));
    const fontMatch = style.match(/font-family\s*:\s*([^;]+)/i);
    if (fontMatch && fontMatch[1]) {
      const primary = fontMatch[1].split(',')[0]?.trim().replace(/["']/g, '') ?? '';
      if (primary && !/serif|sans-serif|monospace/i.test(primary)) fonts.add(primary);
    }
  });
  return {
    colors_hex_candidates: Array.from(colors).slice(0, 8),
    fonts_used: Array.from(fonts).slice(0, 4),
  };
}

function extractCommerce(
  $: cheerio.CheerioAPI,
  theme: ThemeFingerprint,
): ExtractedSourceJson['commerce'] {
  const bundles = extractBundles($, theme);
  const reviews = collectFullReviews($);
  const currency = detectCurrency($);
  const badges = extractBadges($);
  return { reviews, bundles, currency, badges };
}

function extractBundles(
  $: cheerio.CheerioAPI,
  theme: ThemeFingerprint,
): ExtractedSourceJson['commerce']['bundles'] {
  const bundles: ExtractedSourceJson['commerce']['bundles'] = [];
  // Kaching selector
  $('.kaching-bundles__bar').each((_i, el) => {
    const $el = $(el);
    const name = $el.find('.kaching-bundles__bar-title').text().trim();
    const priceText = $el.find('.kaching-bundles__bar-price').text();
    const compareText = $el.find('.kaching-bundles__bar-compare').text();
    const qtyText = $el.find('.kaching-bundles__bar-qty').text();
    const price_cents = parsePriceToCents(priceText);
    if (name && price_cents !== null) {
      const bundle: ExtractedSourceJson['commerce']['bundles'][number] = {
        name,
        price_cents,
        qty: parseQty(qtyText) ?? 1,
      };
      const compare_at_cents = parsePriceToCents(compareText);
      if (compare_at_cents !== null) bundle.compare_at_cents = compare_at_cents;
      bundles.push(bundle);
    }
  });
  // Bepurex .cc-pdp-offer
  if (bundles.length === 0 || theme === 'bepurex') {
    $('.cc-pdp-offer').each((_i, el) => {
      const $el = $(el);
      const name = $el.find('.cc-pdp-offer__title').text().trim();
      const priceText = $el.find('.cc-pdp-offer__price').text();
      const compareText = $el.find('.cc-pdp-offer__compare').text();
      const qtyText = $el.find('.cc-pdp-offer__qty').text();
      const price_cents = parsePriceToCents(priceText);
      if (name && price_cents !== null) {
        const bundle: ExtractedSourceJson['commerce']['bundles'][number] = {
          name,
          price_cents,
          qty: parseQty(qtyText) ?? 1,
        };
        const compare_at_cents = parsePriceToCents(compareText);
        if (compare_at_cents !== null) bundle.compare_at_cents = compare_at_cents;
        bundles.push(bundle);
      }
    });
  }
  // JSON-LD AggregateOffer fallback (não gera bundles individuais, mas
  // registra preço mínimo — usado só quando nada de específico apareceu)
  if (bundles.length === 0) {
    const jsonLdBundles = tryExtractFromJsonLd($);
    bundles.push(...jsonLdBundles);
  }
  // Dedup por name+price
  const seen = new Set<string>();
  return bundles.filter((b) => {
    const key = `${b.name}|${b.price_cents}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tryExtractFromJsonLd(
  $: cheerio.CheerioAPI,
): ExtractedSourceJson['commerce']['bundles'] {
  const bundles: ExtractedSourceJson['commerce']['bundles'] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const raw = $(el).contents().text();
      const data = JSON.parse(raw) as {
        offers?: { lowPrice?: string; highPrice?: string; priceCurrency?: string };
      };
      if (data.offers?.lowPrice) {
        const price = parseFloat(data.offers.lowPrice) * 100;
        if (Number.isFinite(price) && price > 0) {
          bundles.push({ name: 'Base offer', price_cents: Math.round(price), qty: 1 });
        }
      }
    } catch {
      /* JSON-LD malformado — skip */
    }
  });
  return bundles;
}

function collectFullReviews(
  $: cheerio.CheerioAPI,
): ExtractedSourceJson['commerce']['reviews'] {
  const items: ExtractedSourceJson['commerce']['reviews'] = [];
  const process = (
    sel: string,
    bodySel: string[],
    authorSel: string[],
    starSel: string[],
  ) => {
    $(sel).each((_i, el) => {
      const $el = $(el);
      const content = firstNonEmpty(bodySel.map((s) => $el.find(s).text())).trim();
      const author = firstNonEmpty(authorSel.map((s) => $el.find(s).text())).trim();
      const starText = firstNonEmpty(starSel.map((s) => $el.find(s).text()));
      const rating = countStars(starText);
      if (content && author) {
        items.push(rating !== null ? { author, content, rating } : { author, content });
      }
    });
  };
  process(
    '.cc-review-card',
    ['.cc-review-card__body', 'p'],
    ['.cc-review-card__author', 'footer'],
    ['.cc-review-card__stars'],
  );
  process(
    '.spr-review',
    ['.spr-review-content-body', 'p'],
    ['.spr-review-header-byline', 'footer'],
    ['.spr-starratings'],
  );
  return items;
}

function detectCurrency($: cheerio.CheerioAPI): string | null {
  // 1. JSON-LD priceCurrency
  let currency: string | null = null;
  $('script[type="application/ld+json"]').each((_i, el) => {
    if (currency) return;
    try {
      const data = JSON.parse($(el).contents().text()) as {
        offers?: { priceCurrency?: string };
      };
      if (data.offers?.priceCurrency) currency = data.offers.priceCurrency;
    } catch {
      /* skip */
    }
  });
  if (currency) return currency;
  // 2. Sniff símbolo em preços visíveis
  const body = $('body').text();
  if (/€/.test(body)) return 'EUR';
  if (/\$/.test(body)) return 'USD';
  if (/£/.test(body)) return 'GBP';
  if (/R\$/.test(body)) return 'BRL';
  if (/¥/.test(body)) return 'JPY';
  return null;
}

function extractBadges($: cheerio.CheerioAPI): string[] {
  const badges = new Set<string>();
  $('.cc-guarantee p, .guarantee p').each((_i, el) => {
    const text = $(el).text().trim();
    if (!text) return;
    // Split por separadores comuns (·, |, ;)
    text.split(/[·|;]/).forEach((chunk) => {
      const t = chunk.trim();
      if (t && t.length > 3 && t.length < 80) badges.add(t);
    });
  });
  // Alt de badge imgs
  $('.cc-guarantee img, .guarantee img').each((_i, el) => {
    const alt = $(el).attr('alt');
    if (alt && alt.length > 3 && alt.length < 80) badges.add(alt.trim());
  });
  return Array.from(badges);
}

// ─── Step 4: Vision (AC7/AC8/AC9) ────────────────────────────────────────────

interface VisionEnrichment {
  hero_url_candidate?: string;
  logo_url_candidate?: string;
  detected_language?: DetectedLanguage;
  dynamic_extras?: ExtractedSourceJson['dynamic_extras'];
}

async function stepVision(
  screenshot: Buffer,
  base: ExtractedSourceJson,
  theme: ThemeFingerprint,
  trace: SkeletonExtractTrace[],
  overrideCaller?: SkeletonVisionCaller,
): Promise<VisionEnrichment | null> {
  const started = Date.now();
  if (screenshot.length > MAX_SCREENSHOT_BYTES) {
    trace.push({
      step: 'vision-skip-size',
      latencyMs: 0,
      provider: 'vision-gemini',
      notes: `${screenshot.length} bytes > ${MAX_SCREENSHOT_BYTES}`,
    });
    return null;
  }

  const caller = overrideCaller ?? defaultGeminiVisionCaller;
  const cheerioContext = buildCheerioContext(base, theme);
  const screenshotBase64 = screenshot.toString('base64');
  const mime = detectImageMime(screenshot);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < VISION_MAX_RETRIES; attempt++) {
    try {
      const raw = await withTimeout(
        caller({ screenshotBase64, screenshotMime: mime, cheerioContext }),
        VISION_TIMEOUT_MS,
      );
      const parsed = safeParseVisionJson(raw);
      trace.push({
        step: 'vision-gemini',
        latencyMs: Date.now() - started,
        provider: 'vision-gemini',
        notes: `attempt ${attempt + 1} ok · dyn=${parsed.dynamic_extras?.length ?? 0}`,
      });
      return parsed;
    } catch (err) {
      lastErr = err;
      if (attempt === VISION_MAX_RETRIES - 1) break;
      const delay = VISION_RETRY_BASE_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  trace.push({
    step: 'vision-failed',
    latencyMs: Date.now() - started,
    provider: 'vision-gemini',
    notes: `after ${VISION_MAX_RETRIES} attempts: ${errMsg(lastErr)}`,
  });
  return null;
}

function buildCheerioContext(base: ExtractedSourceJson, theme: ThemeFingerprint): string {
  return JSON.stringify(
    {
      theme,
      hero_headline: base.copy.hero_headline,
      benefit_bullets_count: base.copy.benefit_bullets.length,
      faq_count: base.copy.faq.length,
      reviews_count: base.commerce.reviews.length,
      bundles_count: base.commerce.bundles.length,
      currency: base.commerce.currency,
      hero_url_cheerio: base.imagery.hero_url,
      logo_url_cheerio: base.imagery.logo_url,
    },
    null,
    2,
  );
}

const VISION_SYSTEM_PROMPT = `You are a landing page structure analyst. Given a full-page screenshot + a JSON summary of what cheerio already extracted, return STRICT JSON identifying:

1. hero_url_candidate: string | null — pixel-perfect URL of the hero image if visible and distinct from what cheerio found (skip if same).
2. logo_url_candidate: string | null — logo URL if identifiable.
3. detected_language: one of "de" | "it" | "en" | "es" | "fr" | "pt-BR" | null — visual language cue.
4. dynamic_extras: array of up to 3 items shaped { kind, heading, payload, llm_verdict, llm_reason }. Only sections the CHEERIO SUMMARY DOES NOT ALREADY COVER (skip hero, bullets, faq, reviews, bundles).

kind ∈ ["bullets","story","stats","gallery","problem_agitation","solution_benefits","before_after","comparison"].
llm_verdict ∈ ["recommended","optional","skip"]. Only propose "recommended" for sections that clearly reinforce conversion.

Return ONLY valid JSON. No prose, no markdown.`;

async function defaultGeminiVisionCaller(opts: {
  screenshotBase64: string;
  screenshotMime: string;
  cheerioContext: string;
}): Promise<string> {
  // Import dinâmico pra evitar carregar SDK/env em modo degradado ou teste.
  // Bypassa o guard USE_GEMINI_VISION_CLASSIFIER (que era pra image-classifier
  // que roda 200+ vezes por landing). Skeleton Mode chama Vision 1x/landing.
  const originalGuard = process.env['USE_GEMINI_VISION_CLASSIFIER'];
  process.env['USE_GEMINI_VISION_CLASSIFIER'] = '1';
  try {
    const { callGeminiVision } = await import('../providers/gemini-vision.js');
    const result = await callGeminiVision({
      system: VISION_SYSTEM_PROMPT,
      user: `Cheerio summary (JSON):\n${opts.cheerioContext}\n\nAnalyze the screenshot and return the JSON described in the system prompt.`,
      imageBase64: opts.screenshotBase64,
      imageMimeType: opts.screenshotMime,
      // gemini-3.6-flash é o default do provider e cobre Vision Pro-quality
      // pra classificação. Se quiser trocar pro pro, override aqui:
      // model: 'gemini-3.6-pro',
      temperature: 0.2,
      maxTokens: 1024,
      timeoutMs: VISION_TIMEOUT_MS,
    });
    return result.content;
  } finally {
    if (originalGuard === undefined) delete process.env['USE_GEMINI_VISION_CLASSIFIER'];
    else process.env['USE_GEMINI_VISION_CLASSIFIER'] = originalGuard;
  }
}

function safeParseVisionJson(raw: string): VisionEnrichment {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(cleaned) as VisionEnrichment;
    // Sanity: filtrar dynamic_extras via schema parcial
    if (parsed.dynamic_extras && Array.isArray(parsed.dynamic_extras)) {
      parsed.dynamic_extras = parsed.dynamic_extras.slice(0, 3);
    }
    return parsed;
  } catch {
    return {};
  }
}

// ─── Merge & language pickers ────────────────────────────────────────────────

function mergeVisionIntoBase(
  base: ExtractedSourceJson,
  vision: VisionEnrichment | null,
): ExtractedSourceJson {
  if (!vision) return base;
  const merged: ExtractedSourceJson = {
    ...base,
    imagery: {
      ...base.imagery,
      hero_url:
        base.imagery.hero_url ?? vision.hero_url_candidate ?? null,
      logo_url:
        base.imagery.logo_url ?? vision.logo_url_candidate ?? null,
    },
    dynamic_extras: vision.dynamic_extras ?? base.dynamic_extras,
  };
  return merged;
}

function pickDetectedLanguage(
  htmlLangRaw: string | null,
  visionLang: DetectedLanguage,
): DetectedLanguage {
  const fromHtml = normalizeLang(htmlLangRaw);
  if (fromHtml) return fromHtml;
  return visionLang ?? null;
}

function normalizeLang(raw: string | null): DetectedLanguage {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith('pt-br') || lower === 'pt_br') return 'pt-BR';
  if (lower.startsWith('pt')) return 'pt-BR'; // best-effort
  if (lower.startsWith('de')) return 'de';
  if (lower.startsWith('it')) return 'it';
  if (lower.startsWith('en')) return 'en';
  if (lower.startsWith('es')) return 'es';
  if (lower.startsWith('fr')) return 'fr';
  return null;
}

function pickLangFromRawHtml(html: string): string | null {
  const langMatch = html.match(/<html[^>]*\slang=["']([^"']+)["']/i);
  if (langMatch && langMatch[1]) return langMatch[1];
  const metaMatch = html.match(
    /<meta[^>]+http-equiv=["']content-language["'][^>]+content=["']([^"']+)["']/i,
  );
  if (metaMatch && metaMatch[1]) return metaMatch[1];
  return null;
}

// ─── Step 7: Screenshot upload ───────────────────────────────────────────────

async function stepUploadScreenshot(
  screenshot: Buffer | null,
  input: SkeletonExtractInput,
  _trace: SkeletonExtractTrace[],
): Promise<string> {
  if (!screenshot) return '';
  if (!input.storageUploader) {
    // Sem uploader → não falha, apenas retorna path vazio. Consumers de teste
    // e casos degradados fluem sem storage. Real API storyboard: caller injeta.
    return '';
  }
  const timestamp = Date.now();
  const landingId = input.landingId ?? `unknown-${timestamp}`;
  const path = `${landingId}/${timestamp}/screenshot.jpg`;
  try {
    const res = await input.storageUploader({
      bucket: BUCKET_NAME,
      path,
      bytes: screenshot,
      contentType: 'image/jpeg',
    });
    return res.path;
  } catch {
    return '';
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function firstNonEmpty(candidates: Array<string | undefined | null>): string {
  for (const c of candidates) {
    if (c && c.trim().length > 0) return c.trim();
  }
  return '';
}

function parsePriceToCents(text: string | undefined | null): number | null {
  if (!text) return null;
  // Extrai o primeiro número com decimal opcional (aceita "€49", "$49.90", "€ 117,00")
  const match = text.match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!match || !match[1]) return null;
  const normalized = match[1].replace(',', '.');
  const value = parseFloat(normalized);
  if (!Number.isFinite(value)) return null;
  // Se não tem centavos, multiplica por 100. Se tem, também (49.00 → 4900).
  return Math.round(value * 100);
}

function parseQty(text: string | undefined | null): number | null {
  if (!text) return null;
  const match = text.match(/(\d+)/);
  if (!match || !match[1]) return null;
  const value = parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function countStars(text: string): number | null {
  if (!text) return null;
  const filled = (text.match(/★/g) ?? []).length;
  const empty = (text.match(/☆/g) ?? []).length;
  const total = filled + empty;
  if (total === 0) return null;
  return filled;
}

function detectImageMime(buf: Buffer): string {
  // JPEG magic bytes: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  return 'image/jpeg';
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms),
    ),
  ]);
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Helper reexportado pra permitir CLI/testes de arquivo local ─────────────
// Ex: extractFromLocalHtmlFile(path) — não usado direto pela API, útil pra
// devs debugarem em REPL. Fica no módulo principal por conveniência.

export async function extractFromLocalHtmlFile(
  path: string,
  targetSkeleton: SkeletonExtractInput['targetSkeleton'] = 'landing',
): Promise<SkeletonExtractResult> {
  const html = await fs.readFile(path, 'utf8');
  return extractSkeleton({
    url: `file://${path}`,
    htmlOverride: html,
    targetSkeleton,
    disableVision: true,
  });
}

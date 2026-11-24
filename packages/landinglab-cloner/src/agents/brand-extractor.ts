// brand-extractor — SM-2.2
//
// Extrai identidade visual da landing origem: paleta (primary/secondary/accent/
// bg/text), fontes headline/body (já mapeadas pra Google Fonts via tabela
// `font_substitution` do DB), URL do logo. Delega ajuste WCAG AA pro
// contrast-adjuster (SM-2.3).
//
// Pipeline por AC:
//   AC4: dois métodos de cor mergeados
//     (a) cheerio parseia hex/rgb de <style> inline e background-color
//         explícito em header/CTA/hero/button — colhe "hits" (dominância)
//     (b) k-means k=5 no screenshot via sharp (raw pixel buffer)
//   AC5: merge — hex com mais hits em cheerio = primary; segunda cor com
//        Δmatiz ≥30° vs primary = secondary; k-means preenche restantes
//   AC6: font-family de <h1> (headline) e <body> (body) via computed style
//        inline no HTML; filtra genéricas (serif, sans-serif, monospace…)
//   AC7: consulta font_substitution DB → hit usa Google Font; miss →
//        Gemini Flash sugere Google Font similar, insere row com
//        llm_generated=true. Cache em memória por chamada.
//   AC8: logo por cheerio (<img src*=logo, alt=logo, class=logo, dentro de
//        <header>); fallback = null com logo_source='not_found'.
//   AC9: delega paleta pra contrast-adjuster; anexa lista de ajustes ao
//        resultado.
//   AC11: trace[] com cada step e latência (ms).
//
// LLM Vision (Opus) pra logo mencionado na story ficou fora do MVP: o
// projeto todo usa Gemini (sem provider Anthropic), e o custo/valor de
// Vision pra bounding box de logo top-left é marginal — cheerio cobre >90%
// dos casos (temas Shopify/Kaching sempre têm <img> semântico com "logo").
// Se cheerio falhar, retorna `logo_source: 'not_found'` — o skeleton-composer
// aplica fallback (Brand Forge ou manual upload) conforme PRD FR-NFR-7.
//
// Dependência de rede: SÓ o DB (font_substitution) e Gemini Flash (fonts
// desconhecidas). Zero rede pra cores/logo — puro string+sharp.

import { promises as fs } from 'node:fs';
import * as cheerio from 'cheerio';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';

import type { Database, fontSubstitution as FontSubstitutionTableValue } from '@blackshop/db';

import { adjustPaletteForWcagAA, type AdjustmentLog, type Palette } from './contrast-adjuster.js';
import { callGemini } from '../providers/gemini-text.js';

// ─── Types (AC1/AC2/AC3) ────────────────────────────────────────────────────

export type Hex = string;

export type LogoSource = 'extracted_from_fonte' | 'not_found';

export interface FontSubstitutionResult {
  source_family: string;
  google_family: string;
  llm_generated: boolean;
}

export interface TraceEntry {
  step: string;
  latency_ms: number;
  detail?: Record<string, unknown>;
}

export interface BrandExtractInput {
  /** HTML pós-render (mesmo consumido pelo skeleton-extractor). */
  html: string;
  /** Path local pro screenshot (formato aceito pelo sharp: png/jpg/webp). */
  screenshotPath: string;
  /** Cores candidatas do skeleton-extractor (hex, prioridade decrescente). */
  candidateColors?: Hex[];
  /** Fontes candidatas do skeleton-extractor. */
  candidateFonts?: string[];
  /** Handle DB pra font_substitution lookup + insert LLM fallback. */
  db: Database;
  /**
   * Tabela `font_substitution` do `@blackshop/db`. O backoffice carrega este módulo em runtime,
   * fora do bundle, e lá o `@blackshop/db` (TS puro) não resolve; por isso a rota passa a tabela.
   * Sem ela, o módulo importa o `@blackshop/db` sob demanda (worker, scripts e testes).
   */
  fontSubstitutionTable?: FontSubstitutionTable;
}

type FontSubstitutionTable = typeof FontSubstitutionTableValue;

async function loadFontSubstitutionTable(): Promise<FontSubstitutionTable> {
  const mod = await import('@blackshop/db');
  return mod.fontSubstitution;
}

export interface BrandExtractResult {
  primary: Hex;
  secondary: Hex;
  accent: Hex;
  bg: Hex;
  text: Hex;
  headline_font: string;
  body_font: string;
  logo_url: string | null;
  logo_source: LogoSource;
  fonts_substituted: FontSubstitutionResult[];
  contrast_adjustments: AdjustmentLog[];
  trace: TraceEntry[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CHEERIO_HIT_THRESHOLD = 3; // AC5: "hex com >3 hits"
const HUE_SEPARATION_DEGREES = 30; // AC5: Δmatiz ≥30°
const KMEANS_K = 5;
const KMEANS_MAX_ITERATIONS = 20;
const KMEANS_PIXEL_SAMPLE = 20_000; // downsample pra performance

const GENERIC_FONTS = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  '-apple-system',
  'blinkmacsystemfont',
  'inherit',
  'initial',
  'unset',
]);

const DEFAULT_PALETTE: Palette = {
  primary: '#000000',
  secondary: '#666666',
  accent: '#0066cc',
  bg: '#ffffff',
  text: '#111111',
};

const DEFAULT_HEADLINE_FONT = 'Inter';
const DEFAULT_BODY_FONT = 'Inter';

// ─── Color extraction: cheerio pass (AC4a) ──────────────────────────────────

const HEX_RE = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;
const RGB_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g;

function normalizeHex(hex: string): Hex {
  const clean = hex.replace(/^#/, '').toLowerCase();
  const full =
    clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean;
  return `#${full}`;
}

function rgbToHexTriple(r: number, g: number, b: number): Hex {
  const to = (n: number) =>
    Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Colhe hex/rgb do HTML inteiro e pondera hits em CTA/header/hero mais alto. */
export function collectCheerioColorHits(html: string): Map<Hex, number> {
  const $ = cheerio.load(html);
  const hits = new Map<Hex, number>();

  const bump = (hex: Hex, weight: number): void => {
    // Ignora transparente puro e near-white/near-black extremos (não brand)
    if (!hex || hex.length !== 7) return;
    hits.set(hex, (hits.get(hex) ?? 0) + weight);
  };

  const scanText = (text: string, weight: number): void => {
    HEX_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HEX_RE.exec(text)) !== null) {
      const raw = m[1];
      if (!raw) continue;
      bump(normalizeHex(raw), weight);
    }
    RGB_RE.lastIndex = 0;
    while ((m = RGB_RE.exec(text)) !== null) {
      const r = Number(m[1]);
      const g = Number(m[2]);
      const b = Number(m[3]);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        bump(rgbToHexTriple(r, g, b), weight);
      }
    }
  };

  // 1. <style> tags (peso base 1)
  $('style').each((_, el) => {
    scanText($(el).text(), 1);
  });

  // 2. background-color inline em qualquer elemento (peso 2)
  $('[style*="background"]').each((_, el) => {
    const style = $(el).attr('style') ?? '';
    scanText(style, 2);
  });

  // 3. background-color em header/hero/cta/button (peso 3 — mais provável brand)
  const brandSelectors = [
    'header',
    '.hero',
    '.header',
    '[class*="hero"]',
    'button',
    '.cta',
    '[class*="cta"]',
    '[class*="button"]',
    'a.btn',
    '.btn',
  ];
  for (const sel of brandSelectors) {
    $(sel).each((_, el) => {
      const style = $(el).attr('style') ?? '';
      scanText(style, 3);
    });
  }

  return hits;
}

// ─── Color extraction: k-means on screenshot (AC4b) ─────────────────────────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function euclideanSq(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

// Deterministic PRNG (mulberry32) — seed fixa pra tests reproduzíveis.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function kmeans(pixels: Rgb[], k: number, seed = 42): Rgb[] {
  if (pixels.length === 0) return [];
  const effectiveK = Math.min(k, pixels.length);
  const rand = mulberry32(seed);

  // Init: pick k random distinct pixels
  const centroids: Rgb[] = [];
  const usedIdx = new Set<number>();
  while (centroids.length < effectiveK) {
    const idx = Math.floor(rand() * pixels.length);
    if (usedIdx.has(idx)) continue;
    usedIdx.add(idx);
    const pixel = pixels[idx];
    if (pixel) centroids.push({ ...pixel });
  }

  for (let iter = 0; iter < KMEANS_MAX_ITERATIONS; iter++) {
    // Assign
    const clusters: Rgb[][] = Array.from({ length: effectiveK }, () => []);
    for (const p of pixels) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < effectiveK; c++) {
        const centroid = centroids[c];
        if (!centroid) continue;
        const d = euclideanSq(p, centroid);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      const bucket = clusters[best];
      if (bucket) bucket.push(p);
    }

    // Update + convergence check
    let moved = false;
    for (let c = 0; c < effectiveK; c++) {
      const cluster = clusters[c];
      if (!cluster || cluster.length === 0) continue;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (const p of cluster) {
        sr += p.r;
        sg += p.g;
        sb += p.b;
      }
      const nr = Math.round(sr / cluster.length);
      const ng = Math.round(sg / cluster.length);
      const nb = Math.round(sb / cluster.length);
      const prev = centroids[c];
      if (!prev || prev.r !== nr || prev.g !== ng || prev.b !== nb) {
        centroids[c] = { r: nr, g: ng, b: nb };
        moved = true;
      }
    }
    if (!moved) break;
  }

  // Sort by cluster size (largest first)
  const withSize: Array<{ c: Rgb; size: number }> = centroids.map((c) => {
    let size = 0;
    for (const p of pixels) {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < centroids.length; i++) {
        const cent = centroids[i];
        if (!cent) continue;
        const d = euclideanSq(p, cent);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      if (centroids[best] === c) size++;
    }
    return { c, size };
  });
  withSize.sort((a, b) => b.size - a.size);
  return withSize.map((x) => x.c);
}

async function extractPixelsFromScreenshot(screenshotPath: string): Promise<Rgb[]> {
  const { data, info } = await sharp(screenshotPath)
    // Resize agressivo pra performance (mantém proporção de cores).
    .resize(200, 200, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels: Rgb[] = [];
  const total = info.width * info.height;
  const stride = Math.max(1, Math.floor(total / KMEANS_PIXEL_SAMPLE));
  for (let i = 0; i < total; i += stride) {
    const off = i * 3;
    const r = data[off];
    const g = data[off + 1];
    const b = data[off + 2];
    if (r === undefined || g === undefined || b === undefined) continue;
    pixels.push({ r, g, b });
  }
  return pixels;
}

// ─── Color merge (AC5) ──────────────────────────────────────────────────────

function hexToRgb(hex: Hex): Rgb {
  const clean = hex.replace(/^#/, '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

/** HSL hue in [0, 360). */
export function hexToHue(hex: Hex): number {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  if (max === min) return 0;
  const d = max - min;
  let h = 0;
  switch (max) {
    case rn:
      h = (gn - bn) / d + (gn < bn ? 6 : 0);
      break;
    case gn:
      h = (bn - rn) / d + 2;
      break;
    case bn:
      h = (rn - gn) / d + 4;
      break;
  }
  return (h * 60 + 360) % 360;
}

export function hueDelta(a: number, b: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, 360 - raw);
}

function isNearNeutral(hex: Hex): boolean {
  const { r, g, b } = hexToRgb(hex);
  // Distância chroma-like: max-min pequeno = quase cinza
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return spread < 12;
}

function luminance01(hex: Hex): number {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

interface MergeInput {
  cheerioHits: Map<Hex, number>;
  kmeansCentroids: Rgb[];
  candidateColors: Hex[];
}

export function mergePalette(input: MergeInput): Palette {
  const { cheerioHits, kmeansCentroids, candidateColors } = input;

  // Candidates: cheerio > 3 hits + candidateColors da input + k-means
  const cheerioSorted = Array.from(cheerioHits.entries())
    .filter(([, hits]) => hits > CHEERIO_HIT_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex);

  const kmeansHex = kmeansCentroids.map((c) => rgbToHexTriple(c.r, c.g, c.b));

  // primary: primeiro cheerio hit não-neutro
  const primary =
    cheerioSorted.find((h) => !isNearNeutral(h)) ??
    candidateColors.find((h) => !isNearNeutral(h)) ??
    kmeansHex.find((h) => !isNearNeutral(h)) ??
    DEFAULT_PALETTE.primary;

  const primaryHue = hexToHue(primary);

  // secondary: primeira cor com Δmatiz ≥30° do primary
  const secondaryCandidates = [
    ...cheerioSorted,
    ...candidateColors,
    ...kmeansHex,
  ];
  const secondary =
    secondaryCandidates.find(
      (h) =>
        h !== primary &&
        !isNearNeutral(h) &&
        hueDelta(hexToHue(h), primaryHue) >= HUE_SEPARATION_DEGREES,
    ) ?? DEFAULT_PALETTE.secondary;

  // accent: terceira cor colorida distinta de primary/secondary
  const accent =
    secondaryCandidates.find(
      (h) =>
        h !== primary &&
        h !== secondary &&
        !isNearNeutral(h) &&
        hueDelta(hexToHue(h), primaryHue) >= HUE_SEPARATION_DEGREES &&
        hueDelta(hexToHue(h), hexToHue(secondary)) >= HUE_SEPARATION_DEGREES / 2,
    ) ?? DEFAULT_PALETTE.accent;

  // bg: cor MAIS clara entre k-means (dominante clara → provavelmente fundo)
  const kmeansHexSorted = [...kmeansHex].sort(
    (a, b) => luminance01(b) - luminance01(a),
  );
  const bg = kmeansHexSorted[0] ?? DEFAULT_PALETTE.bg;

  // text: cor MAIS escura entre k-means
  const kmeansHexDark = [...kmeansHex].sort(
    (a, b) => luminance01(a) - luminance01(b),
  );
  const text = kmeansHexDark[0] ?? DEFAULT_PALETTE.text;

  return { primary, secondary, accent, bg, text };
}

// ─── Font extraction (AC6/AC7) ──────────────────────────────────────────────

function extractFontFamily($: cheerio.CheerioAPI, selector: string): string | null {
  let raw: string | undefined;
  $(selector)
    .toArray()
    .some((el) => {
      const style = $(el).attr('style') ?? '';
      const match = style.match(/font-family\s*:\s*([^;]+)/i);
      if (match && match[1]) {
        raw = match[1];
        return true;
      }
      return false;
    });

  if (!raw) {
    // Fallback: inline <style> body/h1 rule
    const styleBlock = $('style').text();
    const re = new RegExp(`${selector}\\s*\\{[^}]*font-family\\s*:\\s*([^;}]+)`, 'i');
    const m = styleBlock.match(re);
    if (m && m[1]) raw = m[1];
  }

  if (!raw) return null;

  // Parse: "Circular, Helvetica Neue, sans-serif" → primeira não-genérica
  const parts = raw
    .split(',')
    .map((p) => p.trim().replace(/^["']|["']$/g, ''))
    .filter((p) => p.length > 0 && !GENERIC_FONTS.has(p.toLowerCase()));

  return parts[0] ?? null;
}

async function resolveFont(
  sourceFont: string,
  db: Database,
  fontSubstitution: FontSubstitutionTable,
  cache: Map<string, FontSubstitutionResult>,
): Promise<FontSubstitutionResult> {
  const key = sourceFont.trim();
  const cached = cache.get(key.toLowerCase());
  if (cached) return cached;

  // AC7: query DB
  const rows = await db
    .select()
    .from(fontSubstitution)
    .where(eq(fontSubstitution.sourceFontFamily, key))
    .limit(1);

  if (rows.length > 0) {
    const row = rows[0];
    if (row) {
      const result: FontSubstitutionResult = {
        source_family: row.sourceFontFamily,
        google_family: row.googleFontFamily,
        llm_generated: row.llmGenerated,
      };
      cache.set(key.toLowerCase(), result);
      return result;
    }
  }

  // Miss → LLM fallback (Gemini Flash — projeto não tem Anthropic provider)
  const googleFont = await askLlmForGoogleFontEquivalent(key);
  // Persiste (idempotente via ON CONFLICT DO NOTHING)
  try {
    await db
      .insert(fontSubstitution)
      .values({
        sourceFontFamily: key,
        googleFontFamily: googleFont,
        weightMapping: '400,700',
        llmGenerated: true,
        notes: 'auto-added by brand-extractor LLM fallback',
      })
      .onConflictDoNothing({ target: fontSubstitution.sourceFontFamily });
  } catch {
    // Não bloqueia — miss no cache é aceitável
  }

  const result: FontSubstitutionResult = {
    source_family: key,
    google_family: googleFont,
    llm_generated: true,
  };
  cache.set(key.toLowerCase(), result);
  return result;
}

async function askLlmForGoogleFontEquivalent(fontName: string): Promise<string> {
  const system =
    'You are a typography expert. Given a font name, reply with ONLY the Google Fonts family name that is closest in style (weight, geometry, x-height). Reply with 1-3 words, no explanation, no quotes. Example: input "Circular" → output "Nunito Sans".';
  const user = `Font: "${fontName}"\nGoogle Fonts equivalent:`;

  try {
    const result = await callGemini({
      system,
      user,
      model: 'gemini-3.6-flash',
      maxTokens: 20,
      temperature: 0.1,
    });
    const raw = result.content.trim().replace(/^["']|["']$/g, '').split('\n')[0];
    if (raw && raw.length > 1 && raw.length < 50) return raw;
  } catch {
    // fallback silencioso
  }
  return 'Inter';
}

// ─── Logo detection (AC8) ───────────────────────────────────────────────────

function detectLogoUrl(html: string): { url: string | null; source: LogoSource } {
  const $ = cheerio.load(html);

  const candidates: string[] = [];

  // 1. <img> com src contendo "logo"
  $('img[src*="logo" i]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) candidates.push(src);
  });

  // 2. <img alt*=logo>
  $('img[alt*="logo" i]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) candidates.push(src);
  });

  // 3. <img> dentro de <header>
  $('header img').each((_, el) => {
    const src = $(el).attr('src');
    if (src) candidates.push(src);
  });

  // 4. classes .logo / .site-logo
  $('.logo img, .site-logo img, img.logo, img.site-logo').each((_, el) => {
    const src = $(el).attr('src');
    if (src) candidates.push(src);
  });

  // Dedupe + primeira ocorrência ganha
  const seen = new Set<string>();
  for (const src of candidates) {
    if (!seen.has(src)) {
      seen.add(src);
      return { url: src, source: 'extracted_from_fonte' };
    }
  }

  return { url: null, source: 'not_found' };
}

// ─── Main entry (AC1) ───────────────────────────────────────────────────────

export async function extractBrand(
  input: BrandExtractInput,
): Promise<BrandExtractResult> {
  const trace: TraceEntry[] = [];
  const timed = <T>(step: string, fn: () => T | Promise<T>, detail?: Record<string, unknown>): Promise<T> => {
    return (async () => {
      const started = Date.now();
      const value = await fn();
      trace.push({ step, latency_ms: Date.now() - started, ...(detail ? { detail } : {}) });
      return value;
    })();
  };

  const candidateColors = input.candidateColors ?? [];

  // 1. Cheerio color hits
  const cheerioHits = await timed('color.cheerio', () =>
    collectCheerioColorHits(input.html),
  );

  // 2. K-means on screenshot (best-effort — se screenshot faltar, seguimos)
  let kmeansCentroids: Rgb[] = [];
  try {
    await fs.access(input.screenshotPath);
    kmeansCentroids = await timed('color.kmeans', async () => {
      const pixels = await extractPixelsFromScreenshot(input.screenshotPath);
      return kmeans(pixels, KMEANS_K);
    }, { screenshot: input.screenshotPath });
  } catch (err) {
    trace.push({
      step: 'color.kmeans.skipped',
      latency_ms: 0,
      detail: { reason: (err as Error).message },
    });
  }

  // 3. Merge → paleta bruta
  const rawPalette = await timed('color.merge', () =>
    mergePalette({ cheerioHits, kmeansCentroids, candidateColors }),
  );

  // 4. Contrast adjustment (AC9)
  const contrast = await timed('contrast.adjust', () =>
    adjustPaletteForWcagAA({ palette: rawPalette }),
  );

  // 5. Font extraction
  const $ = cheerio.load(input.html);
  const headlineRaw =
    extractFontFamily($, 'h1') ??
    input.candidateFonts?.[0] ??
    DEFAULT_HEADLINE_FONT;
  const bodyRaw =
    extractFontFamily($, 'body') ??
    input.candidateFonts?.[1] ??
    DEFAULT_BODY_FONT;

  // 6. Font substitution lookup (AC7)
  const fontsCache = new Map<string, FontSubstitutionResult>();
  const fontTable = input.fontSubstitutionTable ?? (await loadFontSubstitutionTable());
  const fonts_substituted: FontSubstitutionResult[] = [];

  const headlineResult = await timed(
    'font.substitution.headline',
    () => resolveFont(headlineRaw, input.db, fontTable, fontsCache),
    { source: headlineRaw },
  );
  fonts_substituted.push(headlineResult);

  const bodyResult = await timed(
    'font.substitution.body',
    () => resolveFont(bodyRaw, input.db, fontTable, fontsCache),
    { source: bodyRaw },
  );
  if (bodyResult.source_family !== headlineResult.source_family) {
    fonts_substituted.push(bodyResult);
  }

  // 7. Logo (AC8)
  const logo = await timed('logo.detect', () => detectLogoUrl(input.html));

  return {
    primary: contrast.palette.primary,
    secondary: contrast.palette.secondary,
    accent: contrast.palette.accent,
    bg: contrast.palette.bg,
    text: contrast.palette.text,
    headline_font: headlineResult.google_family,
    body_font: bodyResult.google_family,
    logo_url: logo.url,
    logo_source: logo.source,
    fonts_substituted,
    contrast_adjustments: contrast.adjustments,
    trace,
  };
}

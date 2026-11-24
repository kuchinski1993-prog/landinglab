// Specs (@landinglab-spec-hunter) — hybrid extraction.
//
// Wave 2: Firecrawl-only.
// Refactor 2026-09-04: Cheerio PRIMÁRIO (zero-cost, ~500ms), Firecrawl FALLBACK.
//
// Chain:
//   1. cheerio.extractFromUrl → se status='ok' AND identity.name → usa
//   2. senão firecrawl.extract → se success → usa
//   3. senão retorna partial com trace.error explicando gap
//
// Motivo: Firecrawl free tier (500 credits/mês) esgota. Sites bem estruturados
// (Shopify DTC, Woo, marketplaces com Schema.org) resolvem via HTML parsing.

import { z } from 'zod';

import type { CheerioClient, CheerioExtractResult } from '../providers/cheerio.js';
import type { FirecrawlClient } from '../providers/firecrawl.js';
import type { TraceEntry, WorkerOutput } from './types.js';

// Shape esperada da extração (subset do PIR identity + o que Sage usa).
export const productExtractionSchema = z.object({
  title: z.string().nullable(),
  description_html: z.string().nullable(),
  specs: z.record(z.string(), z.string()).default({}),
  images: z
    .array(
      z.object({
        url: z.string(),
        alt: z.string().nullable().optional(),
        is_hero: z.boolean().optional(),
        likely_watermarked: z.boolean().optional(),
      }),
    )
    .default([]),
  price: z
    .object({
      amount: z.number().nullable(),
      currency: z.string().nullable(),
      discounted_from: z.number().nullable().optional(),
    })
    .nullable(),
  variants: z
    .array(
      z.object({
        type: z.enum(['color', 'size', 'quantity', 'style']),
        name: z.string(),
        sku: z.string().nullable().optional(),
        price_delta: z.number().nullable().optional(),
      }),
    )
    .default([]),
  reviews_stats: z
    .object({
      avg_rating: z.number().nullable(),
      count: z.number().nullable(),
    })
    .nullable(),
  seller: z
    .object({
      name: z.string().nullable(),
      rating: z.number().nullable(),
      ships_from: z.string().nullable(),
    })
    .nullable(),
});

export type ProductExtraction = z.infer<typeof productExtractionSchema>;

export interface SpecHunterInput {
  sourceUrl: string;
  hint?: { category?: string };
}

export interface SpecHunterDeps {
  cheerio: CheerioClient;
  firecrawl: FirecrawlClient;
}

/** Enriched trace entry — includes source_used for chain observability. */
export interface SpecHunterTraceEntry extends TraceEntry {
  /** 'cheerio' | 'firecrawl' | 'both' (cheerio partial → firecrawl succeeded). */
  source_used?: 'cheerio' | 'firecrawl' | 'both' | 'none';
}

export async function runSpecHunter(
  input: SpecHunterInput,
  deps: SpecHunterDeps,
): Promise<WorkerOutput<ProductExtraction>> {
  const started = Date.now();

  // ─── Attempt 1: cheerio (primary) ─────────────────────────────────────
  let cheerioResult: CheerioExtractResult | null = null;
  let cheerioError: string | null = null;
  try {
    cheerioResult = await deps.cheerio.extractFromUrl(input.sourceUrl);
  } catch (err) {
    cheerioError = err instanceof Error ? err.message : String(err);
  }

  if (cheerioResult && cheerioResult.status === 'ok' && cheerioResult.identity.name) {
    const extraction = cheerioToExtraction(cheerioResult);
    return {
      data: extraction,
      trace: buildTrace({
        provider: 'cheerio',
        source_used: 'cheerio',
        status: 'ok',
        latency_ms: Date.now() - started,
        cost_usd: 0,
      }),
    };
  }

  // ─── Attempt 2: firecrawl (fallback) ──────────────────────────────────
  try {
    const fc = await deps.firecrawl.extract({
      urls: input.sourceUrl,
      schema: productExtractionSchema,
      prompt:
        'Extract structured product data: title, description, technical specs, images, price, variants, reviews stats, seller info. Prefer high-res watermark-free images.',
      waitFor: 3_000,
      timeoutMs: 60_000,
    });
    // Se cheerio deu partial (só title) e firecrawl deu ok → 'both'.
    const usedBoth = cheerioResult?.status === 'partial' && !!cheerioResult.identity.name;
    return {
      data: fc.data,
      trace: buildTrace({
        provider: usedBoth ? 'cheerio+firecrawl' : 'firecrawl',
        source_used: usedBoth ? 'both' : 'firecrawl',
        status: 'ok',
        latency_ms: Date.now() - started,
        cost_usd: fc.cost_usd,
        tokens_in: fc.tokens_in,
        tokens_out: fc.tokens_out,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // ─── Attempt 3: se cheerio deu 'partial', devolve partial ao invés de 'failed' ─
    if (cheerioResult?.status === 'partial' && cheerioResult.identity.name) {
      return {
        data: cheerioToExtraction(cheerioResult),
        trace: buildTrace({
          provider: 'cheerio',
          source_used: 'cheerio',
          status: 'partial',
          latency_ms: Date.now() - started,
          cost_usd: 0,
          error: `firecrawl_fallback_failed:${msg}`,
        }),
      };
    }
    return {
      data: null,
      trace: buildTrace({
        provider: 'firecrawl',
        source_used: cheerioResult ? 'cheerio' : 'none',
        status: 'failed',
        latency_ms: Date.now() - started,
        cost_usd: 0,
        error: cheerioError
          ? `cheerio_error:${cheerioError};firecrawl_error:${msg}`
          : `cheerio_${cheerioResult?.status ?? 'null'}:${cheerioResult?.error ?? 'no_name'};firecrawl_error:${msg}`,
      }),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Cheerio → ProductExtraction mapping
// ─────────────────────────────────────────────────────────────────────────

function cheerioToExtraction(res: CheerioExtractResult): ProductExtraction {
  const specs: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.specs)) {
    specs[k] = String(v);
  }

  return {
    title: res.identity.name,
    description_html: res.identity.description,
    specs,
    images: res.identity.images.map((url, idx) => ({
      url,
      alt: null,
      is_hero: idx === 0,
      likely_watermarked: false,
    })),
    price:
      res.identity.price !== null
        ? { amount: res.identity.price, currency: res.identity.currency }
        : null,
    variants: [], // Cheerio não extrai variants no MVP — fica pra fase 2
    reviews_stats: null, // idem
    seller: null, // idem
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Trace builder
// ─────────────────────────────────────────────────────────────────────────

function buildTrace(opts: {
  provider: string;
  source_used: 'cheerio' | 'firecrawl' | 'both' | 'none';
  status: 'ok' | 'partial' | 'failed';
  latency_ms: number;
  cost_usd: number;
  tokens_in?: number;
  tokens_out?: number;
  error?: string;
}): SpecHunterTraceEntry {
  const t: SpecHunterTraceEntry = {
    agent: 'spec-hunter',
    provider: opts.provider,
    tokens_in: opts.tokens_in ?? 0,
    tokens_out: opts.tokens_out ?? 0,
    cost_usd: opts.cost_usd,
    latency_ms: opts.latency_ms,
    status: opts.status,
    source_used: opts.source_used,
  };
  if (opts.error) t.error = opts.error;
  return t;
}

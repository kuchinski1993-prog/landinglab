// Firecrawl client — usado por @spec-hunter (Specs) pra structured extraction
// de páginas de produto (AliExpress, Amazon, Shopify stores, etc).
//
// Endpoint: https://api.firecrawl.dev/v2/scrape (Bug D 2026-09-09: /v1/extract
// deprecated, migrou pra /v2/scrape com formats:[{type:'json', schema, prompt}]).
// /v1/extract virou async ({id} + polling); /v2/scrape retorna sync.
//
// Cost: ~5 credits por scrape com json format (observado no response body).
// Free tier 500 credits/mês = ~100 scrapes.

import type { z } from 'zod';

import { ProviderConfigError, ProviderHttpError } from './errors.js';

const COST_PER_EXTRACT_USD = 0.05; // 5 credits × $0.01/credit estimado.
const DEFAULT_TIMEOUT_MS = 90_000;
const FIRECRAWL_SCRAPE_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape';

// ─────────────────────────────────────────────────────────────────────────
// Rate limiter (module-level, serializado)
// ─────────────────────────────────────────────────────────────────────────
// Free tier: 3 req/min = 20s interval. Buffer 2s for network jitter → 22s.
// Override via env LANDINGLAB_FIRECRAWL_MIN_INTERVAL_MS (paid tier upgrade).
const DEFAULT_MIN_INTERVAL_MS = 22_000;

function getMinIntervalMs(): number {
  const raw = process.env['LANDINGLAB_FIRECRAWL_MIN_INTERVAL_MS'];
  if (!raw) return DEFAULT_MIN_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_INTERVAL_MS;
}

// Serialization state: garante que N callers paralelos formem uma fila
// em vez de todos verificarem `lastCallAt` simultaneamente.
let lastCallAt = 0;
let rateLimitChain: Promise<void> = Promise.resolve();

async function waitForRateLimit(): Promise<void> {
  // Chain: cada nova espera acontece depois da anterior. Serializa a fila.
  const previous = rateLimitChain;
  let release: () => void = () => {};
  rateLimitChain = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    await previous;
    const minIntervalMs = getMinIntervalMs();
    const now = Date.now();
    const elapsed = now - lastCallAt;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    lastCallAt = Date.now();
  } finally {
    release();
  }
}

// Exposto para reset em testes (não usar em runtime).
export function __resetFirecrawlRateLimiter(): void {
  lastCallAt = 0;
  rateLimitChain = Promise.resolve();
}

export interface FirecrawlExtractOpts<T extends z.ZodTypeAny> {
  urls: string | string[];
  schema: T;
  prompt?: string;
  timeoutMs?: number;
  /** Ms to wait for page hydration (AliExpress hidrata dinamicamente). */
  waitFor?: number;
}

export interface FirecrawlExtractResult<T> {
  data: T;
  urls: string[];
  latency_ms: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

export interface FirecrawlClient {
  extract<T extends z.ZodTypeAny>(
    opts: FirecrawlExtractOpts<T>,
  ): Promise<FirecrawlExtractResult<z.infer<T>>>;
}

// /v2/scrape response shape (com formats: [{type:'json'}]).
interface FirecrawlScrapeResponse {
  success?: boolean;
  data?: {
    json?: unknown;
    metadata?: Record<string, unknown>;
  };
  error?: string;
  warnings?: string[];
}

export function createFirecrawlClient(): FirecrawlClient {
  return {
    async extract(opts) {
      const apiKey = process.env['LANDINGLAB_FIRECRAWL_KEY'];
      if (!apiKey) {
        throw new ProviderConfigError('firecrawl', 'LANDINGLAB_FIRECRAWL_KEY');
      }
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const urls = Array.isArray(opts.urls) ? opts.urls : [opts.urls];
      const started = Date.now();

      // /v2/scrape aceita 1 URL por request. Para múltiplas URLs, fazer sequencial
      // respeitando rate limiter (batch requests é feature separada em Firecrawl v2).
      // Callers atuais (spec-hunter) só passam 1 URL, então casos multi-URL são raros.
      if (urls.length > 1) {
        const results = await Promise.all(
          urls.map((u) => scrapeSingleUrl(u, opts, apiKey, timeoutMs, started)),
        );
        // Merge: pega o primeiro success. Se todos falharem, primeiro erro sobe.
        const firstOk = results.find((r) => r !== null);
        if (!firstOk) throw new Error('firecrawl_all_urls_failed');
        return firstOk;
      }

      const result = await scrapeSingleUrl(urls[0]!, opts, apiKey, timeoutMs, started);
      if (!result) throw new ProviderHttpError('firecrawl', 200, 'empty');
      return result;
    },
  };
}

async function scrapeSingleUrl<T extends z.ZodTypeAny>(
  url: string,
  opts: FirecrawlExtractOpts<T>,
  apiKey: string,
  timeoutMs: number,
  started: number,
): Promise<FirecrawlExtractResult<z.infer<T>> | null> {
  const jsonSchema = zodToJsonSchemaLike(opts.schema);
  const body = JSON.stringify({
    url,
    formats: [
      {
        type: 'json',
        schema: jsonSchema,
        prompt: opts.prompt,
      },
    ],
    onlyMainContent: true,
  });

  // Retry 1x em erros transitórios (5xx/network).
  const attempts = [0, 1];
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      await waitForRateLimit();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(FIRECRAWL_SCRAPE_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body,
          signal: controller.signal,
        });
        const responseText = await res.text();
        if (!res.ok) {
          throw new ProviderHttpError('firecrawl', res.status, responseText);
        }
        const parsed = JSON.parse(responseText) as FirecrawlScrapeResponse;
        if (!parsed.success || !parsed.data?.json) {
          if (i < attempts.length - 1) {
            lastErr = new Error(parsed.error ?? 'firecrawl_empty_json');
            continue;
          }
          return null;
        }
        // Best-effort Zod validation — se falhar, retornamos raw data (Sage
        // decide se é utilizável).
        const validated = opts.schema.safeParse(parsed.data.json);
        const data = validated.success ? validated.data : parsed.data.json;
        return {
          data,
          urls: [url],
          latency_ms: Date.now() - started,
          cost_usd: COST_PER_EXTRACT_USD,
          tokens_in: 0,
          tokens_out: 0,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastErr = err as Error;
      if (err instanceof ProviderHttpError && err.status === 429) {
        const retryAfterSecs = parseRetryAfter(err) ?? 60;
        if (retryAfterSecs > 60) {
          throw err;
        }
        if (i === attempts.length - 1) throw err;
        await sleep(retryAfterSecs * 1_000);
        continue;
      }
      if (err instanceof ProviderHttpError && err.status >= 400 && err.status < 500) {
        throw err;
      }
      if (i === attempts.length - 1) throw err;
      await sleep(1_000);
    }
  }
  throw lastErr ?? new Error('firecrawl_unknown_error');
}

// ─────────────────────────────────────────────────────────────────────────
// Zod → JSON Schema (minimal conversor pra endpoints que aceitam JSON Schema)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Conversor Zod → JSON Schema simplificado. Suporta os tipos que usamos no
 * spec-hunter (object, string, number, boolean, array, record, nullable, optional).
 * Firecrawl aceita JSON Schema draft-07 no field `schema`.
 */
function zodToJsonSchemaLike(schema: z.ZodTypeAny): Record<string, unknown> {
  // Walk via _def — não usa lib externa (mantém deps mínimas).
  const def = (schema._def ?? {}) as { typeName?: string; [k: string]: unknown };
  const typeName = def.typeName;

  if (typeName === 'ZodString') return { type: 'string' };
  if (typeName === 'ZodNumber') return { type: 'number' };
  if (typeName === 'ZodBoolean') return { type: 'boolean' };
  if (typeName === 'ZodNull') return { type: 'null' };

  if (typeName === 'ZodArray') {
    const inner = (def as { type: z.ZodTypeAny }).type;
    return { type: 'array', items: zodToJsonSchemaLike(inner) };
  }
  if (typeName === 'ZodOptional' || typeName === 'ZodNullable' || typeName === 'ZodDefault') {
    const inner = (def as { innerType: z.ZodTypeAny }).innerType;
    const child = zodToJsonSchemaLike(inner);
    if (typeName === 'ZodNullable') {
      // JSON Schema draft-07: type array pra permitir null.
      const t = child['type'];
      if (typeof t === 'string') return { ...child, type: [t, 'null'] };
    }
    return child;
  }
  if (typeName === 'ZodObject') {
    const shape = (def as { shape: () => Record<string, z.ZodTypeAny> }).shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodToJsonSchemaLike(val);
      const inner = (val._def ?? {}) as { typeName?: string };
      if (inner.typeName !== 'ZodOptional' && inner.typeName !== 'ZodDefault') {
        required.push(key);
      }
    }
    return { type: 'object', properties, required };
  }
  if (typeName === 'ZodRecord') {
    const value = (def as { valueType: z.ZodTypeAny }).valueType;
    return { type: 'object', additionalProperties: zodToJsonSchemaLike(value) };
  }
  if (typeName === 'ZodEnum') {
    const values = (def as { values: readonly string[] }).values;
    return { type: 'string', enum: Array.from(values) };
  }
  if (typeName === 'ZodUnion') {
    const options = (def as { options: z.ZodTypeAny[] }).options;
    return { anyOf: options.map(zodToJsonSchemaLike) };
  }
  if (typeName === 'ZodLiteral') {
    const value = (def as { value: unknown }).value;
    return { const: value };
  }
  // Fallback: aceita qualquer coisa.
  return {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses retry-after hint from a 429 ProviderHttpError.
 *
 * Firecrawl encodes retry-after in the body text (e.g. "please retry after 53s"
 * or "rate limit exceeded, please try again in 45 seconds"). ProviderHttpError
 * não expõe headers hoje — se algum dia expuser, adicionar leitura de
 * `Retry-After` header aqui como primeira opção.
 *
 * Returns seconds as a positive number, or null se não conseguir parsear.
 */
function parseRetryAfter(err: ProviderHttpError): number | null {
  const body = err.body ?? '';
  // Match "retry after 53s", "retry after 53 seconds", "try again in 45s", "in 45 seconds".
  const patterns = [
    /retry after (\d+)\s*s(?:ec(?:onds?)?)?/i,
    /try again in (\d+)\s*s(?:ec(?:onds?)?)?/i,
    /rate limit.*?(\d+)\s*s(?:ec(?:onds?)?)?/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// Perplexity Sonar client — usado por @market-analyst (Marco).
//
// Endpoint: https://api.perplexity.ai/chat/completions (OpenAI-compatible)
// Modelo default v1: 'sonar-pro' (NÃO sonar-deep-research — controle de custo).
// Cost: sonar-pro ~$1/M in + $1/M out + $5/1k searches (embutimos custo por search flat estimado).

import { ProviderConfigError, ProviderHttpError } from './errors.js';

// Reduced from 60s (2 calls sequential could exhaust orchestrator global timeout of 240s)
const DEFAULT_TIMEOUT_MS = 30_000;
const PPLX_ENDPOINT = 'https://api.perplexity.ai/chat/completions';

// Sonar Pro pricing (dez/2026): $1/M in, $1/M out, $5/1000 searches.
const COST_INPUT_PER_TOKEN = 1 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 1 / 1_000_000;
const COST_PER_SEARCH = 5 / 1000; // flat quando reasoning happens

export type PerplexityModel = 'sonar' | 'sonar-pro' | 'sonar-reasoning';

export interface PerplexityChatOpts {
  model?: PerplexityModel;
  system: string;
  user: string;
  jsonSchema?: Record<string, unknown>;
  /**
   * Hint: caller wants JSON but sem schema estrito. Sonar Pro rejeita
   * `response_format.type = "json_object"`, então este flag NÃO envia
   * response_format — o caller depende de:
   *   1. Prompt aggressivo (system message dizendo "return only JSON")
   *   2. Post-processing para strip markdown fences se Sonar teimosamente
   *      envolver a resposta em ``` blocks (ver tryParseJson no market-analyst).
   * Ignorado se jsonSchema for passado (schema tem prioridade).
   */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface PerplexityCitation {
  url: string;
  title: string | null;
}

export interface PerplexityChatResult {
  content: string | Record<string, unknown>;
  citations: PerplexityCitation[];
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  cost_usd: number;
  model: PerplexityModel;
}

interface PerplexityChatResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  citations?: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface PerplexityClient {
  chat(opts: PerplexityChatOpts): Promise<PerplexityChatResult>;
}

export function createPerplexityClient(): PerplexityClient {
  return {
    async chat(opts: PerplexityChatOpts): Promise<PerplexityChatResult> {
      const apiKey = process.env['LANDINGLAB_PERPLEXITY_KEY'];
      if (!apiKey) {
        throw new ProviderConfigError('perplexity', 'LANDINGLAB_PERPLEXITY_KEY');
      }
      const model: PerplexityModel = opts.model ?? 'sonar-pro';
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const temperature = opts.temperature ?? 0.2;
      const maxTokens = opts.maxTokens ?? 2000;

      const body: Record<string, unknown> = {
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      };
      // Bug C v2: Perplexity Sonar Pro rejects `response_format.type = "json_object"`
      // with 400 ("must be one of json_schema, text"). Strategy:
      // - jsonSchema passed  → use official json_schema mode (strict, may truncate)
      // - jsonMode w/o schema → DO NOT send response_format. Rely on aggressive prompt
      //   engineering + stripMarkdownFences on parse (see market-analyst.ts + tryParseJson).
      if (opts.jsonSchema) {
        body['response_format'] = { type: 'json_schema', json_schema: { schema: opts.jsonSchema } };
      }

      const started = Date.now();
      // Retry 1x em 5xx / timeout / rate-limit.
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(PPLX_ENDPOINT, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            });
            const raw = await res.text();
            if (!res.ok) {
              // Retry 5xx/429; fail-fast 4xx.
              if (res.status >= 500 || res.status === 429) {
                if (attempt === 0) {
                  lastErr = new ProviderHttpError('perplexity', res.status, raw);
                  await sleep(1_500);
                  continue;
                }
              }
              throw new ProviderHttpError('perplexity', res.status, raw);
            }
            const parsed = JSON.parse(raw) as PerplexityChatResponse;
            const contentStr = parsed.choices?.[0]?.message?.content ?? '';
            const tokens_in = parsed.usage?.prompt_tokens ?? 0;
            const tokens_out = parsed.usage?.completion_tokens ?? 0;
            const citations = (parsed.citations ?? []).map((url) => ({ url, title: null as string | null }));
            const cost_usd =
              tokens_in * COST_INPUT_PER_TOKEN + tokens_out * COST_OUTPUT_PER_TOKEN + COST_PER_SEARCH;

            let content: string | Record<string, unknown> = contentStr;
            if (opts.jsonSchema || opts.jsonMode) {
              // Sonar Pro frequentemente envolve JSON em ```json ... ``` mesmo
              // sendo instruído a não fazer. Strip fences antes de parse.
              const cleaned = stripMarkdownFences(contentStr);
              try {
                content = JSON.parse(cleaned) as Record<string, unknown>;
              } catch {
                // Content pediu JSON e veio prose: caller lida (agent pode retry).
                content = contentStr;
              }
            }
            return {
              content,
              citations,
              tokens_in,
              tokens_out,
              latency_ms: Date.now() - started,
              cost_usd,
              model,
            };
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          lastErr = err as Error;
          if (err instanceof ProviderHttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
            throw err;
          }
          if (attempt === 1) throw err;
          await sleep(1_500);
        }
      }
      throw lastErr ?? new Error('perplexity_unknown_error');
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Strip markdown code fences that Sonar Pro often adds even when instructed
 * to return raw JSON. Handles both ```json ... ``` and ``` ... ``` variants,
 * plus leading/trailing whitespace.
 */
export function stripMarkdownFences(text: string): string {
  return text
    .replace(/^\s*```(?:json|JSON)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/i, '')
    .trim();
}

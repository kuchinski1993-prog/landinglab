// Marco (@landinglab-market-analyst) — market + competitive research via Perplexity Sonar Pro.
//
// Wave 2 impl: structured prompt per landinglab-market-analyst.md spec.
// Fallback: se JSON inválido, retry 1x com prompt tightened.

import { stripMarkdownFences } from '../providers/perplexity.js';
import type { PerplexityChatResult, PerplexityClient, PerplexityCitation } from '../providers/perplexity.js';
import type { WorkerOutput } from './types.js';

export interface MarketAnalystInput {
  productTitle: string;
  category: string | null;
  brand: string | null;
  specs: Record<string, string | number | boolean>;
  targetLanguage: 'de' | 'it' | 'en' | 'es' | 'fr';
}

export interface MarketIntel {
  avatar_hypothesis: {
    demographic_hints: { age_range: string | null; income_range: string | null; life_situation: string | null };
    core_functional_job: string;
    context_of_use: string;
    triggers: string[];
  };
  market: {
    sophistication_level: number;
    sophistication_reasoning: string;
    category_maturity: string;
    market_size_hint: string | null;
    trends_2025_2026: string[];
  };
  competitors: Array<{
    name: string;
    price_range: string | null;
    positioning: string;
    strengths: string[];
    gaps: string[];
    url: string | null;
  }>;
  differentiation_hypotheses: string[];
  awareness_map: {
    unaware: { trigger_hook: string; education_needed: string[] };
    problem_aware: { problem_statement: string };
    solution_aware: { comparison_angles: string[]; differentiators: string[] };
    product_aware: { objections_to_kill: string[]; proof_needed: string[] };
    most_aware: { offer_stack_hint: string; urgency_hint: string };
  };
  citations: PerplexityCitation[];
}

// Bug C v2: Sonar Pro rejeita response_format=json_object. Estratégia:
//   1. Prompt AGRESSIVO (system + user) — múltiplas repetições da regra
//   2. stripMarkdownFences no parse — belt em cima do suspender
//   3. tryParseJson com fallback multi-estratégia (fences, primeira {…})
const SYSTEM_PROMPT =
  'You are a market research analyst. You MUST respond with valid JSON only. ' +
  'Your response starts with { and ends with }. ' +
  'NO markdown code fences (no ``` or ```json). ' +
  'NO explanation before or after the JSON. ' +
  'NO headers, no titles, no prose. ' +
  'If you cannot answer as JSON, return: {"error": "reason here"}. ' +
  'Every non-generic factual claim MUST include a citation URL. ' +
  'Distinguish speculation ("typical avatar likely includes...") from cited fact ("per Statista 2025, X% of buyers are Y"). ' +
  'Provide minimum 3 competitors. Use Schwartz 1-5 for sophistication_level with explicit reasoning.';

function buildUserPrompt(input: MarketAnalystInput): string {
  const specsSummary = Object.entries(input.specs ?? {})
    .slice(0, 8)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `Product: ${input.productTitle}${input.category ? ` (${input.category})` : ''}${
    input.brand ? `, brand: ${input.brand}` : ''
  }.
Specs: ${specsSummary || 'unknown'}.
Market to consider: general Western consumer (adapt language framing to ${input.targetLanguage} audience but keep response in English).

Return JSON:
{
  "avatar_hypothesis": { "demographic_hints": { "age_range": "", "income_range": "", "life_situation": "" }, "core_functional_job": "solution-free ODI statement", "context_of_use": "", "triggers": [] },
  "market": { "sophistication_level": 1-5, "sophistication_reasoning": "", "category_maturity": "emerging|growth|mature|declining", "market_size_hint": "", "trends_2025_2026": [] },
  "competitors": [ { "name": "", "price_range": "", "positioning": "", "strengths": [], "gaps": [], "url": "" } ],
  "differentiation_hypotheses": [],
  "awareness_map": {
    "unaware": { "trigger_hook": "", "education_needed": [] },
    "problem_aware": { "problem_statement": "" },
    "solution_aware": { "comparison_angles": [], "differentiators": [] },
    "product_aware": { "objections_to_kill": [], "proof_needed": [] },
    "most_aware": { "offer_stack_hint": "", "urgency_hint": "" }
  },
  "citations": [ { "url": "", "title": "" } ]
}`;
}

export async function runMarketAnalyst(
  input: MarketAnalystInput,
  deps: { perplexity: PerplexityClient },
): Promise<WorkerOutput<MarketIntel>> {
  const started = Date.now();
  // Reduced from 60s per call. 2 sequential calls × 60s could burn full orchestrator
  // global timeout of 240s (compounded by orchestrator withRetry + provider internal retry).
  const PPLX_TIMEOUT_MS = 30_000;
  try {
    // 1ª tentativa com prompt padrão. jsonMode força response_format=json_object
    // (bug C: sem isso, Sonar Pro retorna prosa markdown).
    const attempt1StartedAt = Date.now();
    console.log('[market-analyst] Perplexity call started', { attempt: 1, timeoutMs: PPLX_TIMEOUT_MS });
    let first: PerplexityChatResult;
    try {
      first = await deps.perplexity.chat({
        model: 'sonar-pro',
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(input),
        jsonMode: true,
        temperature: 0.2,
        maxTokens: 3000,
        timeoutMs: PPLX_TIMEOUT_MS,
      });
      console.log('[market-analyst] Perplexity call completed', {
        attempt: 1,
        elapsedMs: Date.now() - attempt1StartedAt,
      });
    } catch (err) {
      console.log('[market-analyst] Perplexity call failed', {
        attempt: 1,
        elapsedMs: Date.now() - attempt1StartedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const parsed = tryParseJson(first.content);
    if (parsed) {
      return buildOk(parsed, first.tokens_in, first.tokens_out, first.cost_usd, first.latency_ms, first.citations);
    }

    // Retry: prompt tightened pra JSON válido (temperature ainda menor).
    const attempt2StartedAt = Date.now();
    console.log('[market-analyst] Perplexity call started', { attempt: 2, timeoutMs: PPLX_TIMEOUT_MS });
    let second: PerplexityChatResult;
    try {
      second = await deps.perplexity.chat({
        model: 'sonar-pro',
        system: `${SYSTEM_PROMPT}\n\nRETRY: Previous response was not valid JSON. Return raw JSON only, starting with { and ending with }.`,
        user: buildUserPrompt(input),
        jsonMode: true,
        temperature: 0.1,
        maxTokens: 3000,
        timeoutMs: PPLX_TIMEOUT_MS,
      });
      console.log('[market-analyst] Perplexity call completed', {
        attempt: 2,
        elapsedMs: Date.now() - attempt2StartedAt,
      });
    } catch (err) {
      console.log('[market-analyst] Perplexity call failed', {
        attempt: 2,
        elapsedMs: Date.now() - attempt2StartedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const parsed2 = tryParseJson(second.content);
    if (parsed2) {
      return buildOk(
        parsed2,
        first.tokens_in + second.tokens_in,
        first.tokens_out + second.tokens_out,
        first.cost_usd + second.cost_usd,
        Date.now() - started,
        [...first.citations, ...second.citations],
      );
    }

    return {
      data: null,
      trace: {
        agent: 'market-analyst',
        provider: 'perplexity_sonar_pro',
        tokens_in: first.tokens_in + second.tokens_in,
        tokens_out: first.tokens_out + second.tokens_out,
        cost_usd: first.cost_usd + second.cost_usd,
        latency_ms: Date.now() - started,
        status: 'failed',
        error: 'invalid_json_after_retry',
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      data: null,
      trace: {
        agent: 'market-analyst',
        provider: 'perplexity_sonar_pro',
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        latency_ms: Date.now() - started,
        status: 'failed',
        error: msg,
      },
    };
  }
}

function buildOk(
  parsed: Record<string, unknown>,
  tokens_in: number,
  tokens_out: number,
  cost_usd: number,
  latency_ms: number,
  citations: PerplexityCitation[],
): WorkerOutput<MarketIntel> {
  // Attach citations if not present.
  const intel = parsed as unknown as MarketIntel;
  if (!intel.citations || intel.citations.length === 0) {
    intel.citations = citations;
  }
  return {
    data: intel,
    trace: {
      agent: 'market-analyst',
      provider: 'perplexity_sonar_pro',
      tokens_in,
      tokens_out,
      cost_usd,
      latency_ms,
      status: 'ok',
    },
  };
}

function tryParseJson(content: string | Record<string, unknown>): Record<string, unknown> | null {
  if (typeof content !== 'string') return content;

  // 1. Try direct parse (happy path).
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    // fallthrough
  }

  // 2. Strip markdown fences (```json ... ``` or ``` ... ```) and retry.
  const stripped = stripMarkdownFences(content);
  if (stripped !== content) {
    try {
      return JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      // fallthrough
    }
  }

  // 3. Try explicit fenced block match (redundant, but handles nested fences).
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]) as Record<string, unknown>;
    } catch {
      // fallthrough
    }
  }

  // 4. Last resort: extract first {...} balanced-ish block (accepts prose wrapping).
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = content.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return null;
}

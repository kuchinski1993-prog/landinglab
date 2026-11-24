// Vera (@landinglab-vision-verifier) — Modo B rerank + attribute extraction.
//
// Provider default: Gemini 2.0 Flash (~200x mais barato que Claude Opus vision).
// Fallback: Claude Opus quando Gemini falha (rate-limit, credit, etc).
// Retry 1x on invalid JSON, dentro do provider primário.
// Confidence < 0.6 → return status 'low_confidence'.

import type { ClaudeContentBlock, ClaudeVisionClient } from '../providers/claude-vision.js';
import type { GeminiContentBlock, GeminiVisionClient } from '../providers/gemini-vision.js';
import type { LensVisualMatch } from '../providers/serpapi.js';
import type { WorkerOutput } from './types.js';

export interface VisionVerifierInput {
  sourceImageUrl: string;
  candidates: LensVisualMatch[];
}

export interface VisionVerifierData {
  status: 'ok' | 'low_confidence';
  best_match: LensVisualMatch | null;
  confidence: number;
  reasoning: string;
  attributes_extracted: {
    brand: string | null;
    model: string | null;
    category: string | null;
    key_features: string[];
    text_on_packaging: string | null;
    colors_visible: string[];
  };
}

// Interface interna comum aos dois providers. ClaudeContentBlock e
// GeminiContentBlock têm shape idêntico intencionalmente.
type VisionBlock = ClaudeContentBlock & GeminiContentBlock;

export interface VisionVerifierDeps {
  /** Primary provider. Recomendado: Gemini 2.0 Flash (barato + rápido). */
  gemini?: GeminiVisionClient;
  /** Fallback provider quando primary falha. */
  claude?: ClaudeVisionClient;
}

const SYSTEM =
  'You are a product identification expert. Compare the target image with the candidate thumbnails. ' +
  'Rank by likelihood of exact match (same product, same variant if visible). Read visible text on packaging.';

function buildUserContent(
  sourceImageUrl: string,
  candidates: LensVisualMatch[],
): VisionBlock[] {
  const top5 = candidates.slice(0, 5);
  const blocks: VisionBlock[] = [
    { type: 'text', text: 'TARGET image:' },
    { type: 'image', source: { type: 'url', url: sourceImageUrl } },
  ];
  top5.forEach((c, i) => {
    blocks.push({ type: 'text', text: `CANDIDATE ${i}: ${c.title ?? 'no title'} — ${c.source_url}` });
    if (c.thumbnail) blocks.push({ type: 'image', source: { type: 'url', url: c.thumbnail } });
  });
  blocks.push({
    type: 'text',
    text:
      'Return JSON: { "best_match_index": int, "confidence": 0-1, "reasoning": str, ' +
      '"attributes_read": { "brand": str|null, "model": str|null, "category": str|null, ' +
      '"key_features": [str], "text_on_packaging": str|null, "colors_visible": [str] } }',
  });
  return blocks;
}

interface VisionRaw {
  best_match_index?: number;
  confidence?: number;
  reasoning?: string;
  attributes_read?: {
    brand?: string | null;
    model?: string | null;
    category?: string | null;
    key_features?: string[];
    text_on_packaging?: string | null;
    colors_visible?: string[];
  };
}

interface ProviderCallResult {
  parsed: VisionRaw | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  provider: string;
  error: string | null;
}

async function callGemini(
  client: GeminiVisionClient,
  content: VisionBlock[],
): Promise<ProviderCallResult> {
  try {
    const first = await client.createMessage({
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 1000,
      timeoutMs: 45_000,
    });
    let parsed = tryParseJson(first.content);
    let tokens_in = first.tokens_in;
    let tokens_out = first.tokens_out;
    let cost_usd = first.cost_usd;

    if (!parsed) {
      const retry = await client.createMessage({
        system: `${SYSTEM}\n\nCRITICAL: Return VALID JSON only. No prose, no markdown, no code fences.`,
        messages: [{ role: 'user', content }],
        jsonMode: true,
        temperature: 0.1,
        maxTokens: 1000,
        timeoutMs: 45_000,
      });
      parsed = tryParseJson(retry.content);
      tokens_in += retry.tokens_in;
      tokens_out += retry.tokens_out;
      cost_usd += retry.cost_usd;
    }

    return {
      parsed,
      tokens_in,
      tokens_out,
      cost_usd,
      provider: 'gemini_2_0_flash_vision',
      error: parsed ? null : 'invalid_json_after_retry',
    };
  } catch (err) {
    return {
      parsed: null,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      provider: 'gemini_2_0_flash_vision',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function callClaude(
  client: ClaudeVisionClient,
  content: VisionBlock[],
): Promise<ProviderCallResult> {
  try {
    const first = await client.createMessage({
      model: 'claude-opus-4-7',
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 1000,
      timeoutMs: 30_000,
    });
    let parsed = tryParseJson(first.content);
    let tokens_in = first.tokens_in;
    let tokens_out = first.tokens_out;
    let cost_usd = first.cost_usd;

    if (!parsed) {
      const retry = await client.createMessage({
        model: 'claude-opus-4-7',
        system: `${SYSTEM}\n\nCRITICAL: Return VALID JSON only. No prose, no markdown, no code fences.`,
        messages: [{ role: 'user', content }],
        jsonMode: true,
        temperature: 0.1,
        maxTokens: 1000,
        timeoutMs: 30_000,
      });
      parsed = tryParseJson(retry.content);
      tokens_in += retry.tokens_in;
      tokens_out += retry.tokens_out;
      cost_usd += retry.cost_usd;
    }

    return {
      parsed,
      tokens_in,
      tokens_out,
      cost_usd,
      provider: 'claude_opus_4_7_vision',
      error: parsed ? null : 'invalid_json_after_retry',
    };
  } catch (err) {
    return {
      parsed: null,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      provider: 'claude_opus_4_7_vision',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runVisionVerifier(
  input: VisionVerifierInput,
  deps: VisionVerifierDeps,
): Promise<WorkerOutput<VisionVerifierData>> {
  const started = Date.now();

  if (input.candidates.length === 0) {
    return {
      data: null,
      trace: {
        agent: 'vision-verifier',
        provider: deps.gemini ? 'gemini_2_0_flash_vision' : 'claude_opus_4_7_vision',
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        latency_ms: 0,
        status: 'failed',
        error: 'no_candidates_to_verify',
      },
    };
  }

  const content = buildUserContent(input.sourceImageUrl, input.candidates);

  // 1) Try Gemini first (if configured). ~200x mais barato + costuma responder rápido.
  // 2) Fallback pra Claude quando Gemini falha (credit, rate-limit, invalid JSON, etc).
  let primary: ProviderCallResult;
  if (deps.gemini) {
    primary = await callGemini(deps.gemini, content);
  } else if (deps.claude) {
    primary = await callClaude(deps.claude, content);
  } else {
    return {
      data: null,
      trace: {
        agent: 'vision-verifier',
        provider: 'none_configured',
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        latency_ms: Date.now() - started,
        status: 'failed',
        error: 'no_vision_provider_configured',
      },
    };
  }

  // Se primary falhou E temos fallback Claude, tenta.
  let usedProvider = primary.provider;
  let combinedTokensIn = primary.tokens_in;
  let combinedTokensOut = primary.tokens_out;
  let combinedCost = primary.cost_usd;
  let parsed = primary.parsed;
  let lastError = primary.error;

  if (!parsed && deps.claude && deps.gemini) {
    // Só cai no fallback se estávamos usando Gemini como primary.
    const fb = await callClaude(deps.claude, content);
    combinedTokensIn += fb.tokens_in;
    combinedTokensOut += fb.tokens_out;
    combinedCost += fb.cost_usd;
    if (fb.parsed) {
      parsed = fb.parsed;
      usedProvider = `${primary.provider}+fallback:${fb.provider}`;
      lastError = null;
    } else {
      usedProvider = `${primary.provider}+fallback_failed:${fb.provider}`;
      lastError = fb.error;
    }
  }

  if (!parsed) {
    return {
      data: null,
      trace: {
        agent: 'vision-verifier',
        provider: usedProvider,
        tokens_in: combinedTokensIn,
        tokens_out: combinedTokensOut,
        cost_usd: combinedCost,
        latency_ms: Date.now() - started,
        status: 'failed',
        error: lastError ?? 'unknown_vision_failure',
      },
    };
  }

  const idx = typeof parsed.best_match_index === 'number' ? parsed.best_match_index : 0;
  const best = input.candidates[idx] ?? input.candidates[0] ?? null;
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  const status: 'ok' | 'low_confidence' = confidence >= 0.6 ? 'ok' : 'low_confidence';

  return {
    data: {
      status,
      best_match: best,
      confidence,
      reasoning: parsed.reasoning ?? '',
      attributes_extracted: {
        brand: parsed.attributes_read?.brand ?? null,
        model: parsed.attributes_read?.model ?? null,
        category: parsed.attributes_read?.category ?? null,
        key_features: parsed.attributes_read?.key_features ?? [],
        text_on_packaging: parsed.attributes_read?.text_on_packaging ?? null,
        colors_visible: parsed.attributes_read?.colors_visible ?? [],
      },
    },
    trace: {
      agent: 'vision-verifier',
      provider: usedProvider,
      tokens_in: combinedTokensIn,
      tokens_out: combinedTokensOut,
      cost_usd: combinedCost,
      latency_ms: Date.now() - started,
      status: status === 'ok' ? 'ok' : 'partial',
    },
  };
}

function tryParseJson(content: string): VisionRaw | null {
  try {
    return JSON.parse(content) as VisionRaw;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as VisionRaw;
      } catch {
        return null;
      }
    }
    return null;
  }
}

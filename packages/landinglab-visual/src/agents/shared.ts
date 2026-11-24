// Shared helpers para os 5 agentes generativos do Squad 3.
//
// Encapsula:
//   - generateWithFallback: try primary → try fallback → return null (graceful).
//   - Emite VisualTraceEntry por tentativa (independente de sucesso).
//   - JSON parse com tolerância a code fences (mirror Squad 2 shared.ts).

import { FreepikProviderError, HiggsFieldProviderError } from '../providers/errors.js';
import type {
  GenerateImageInput,
  GenerateImageOutput,
  ImageProvider,
} from '../providers/types.js';
import type { VisualTraceEntry } from '../orchestrator.js';
import type { VisualAgentName } from './types.js';

export interface GenerateWithFallbackDeps {
  primary: ImageProvider;
  fallback?: ImageProvider;
}

export interface GenerateWithFallbackResult {
  output: GenerateImageOutput | null;
  traces: VisualTraceEntry[];
  /** Se placeholder foi usado (Higgsfield sem key/endpoint), sinaliza para director_notes. */
  placeholderUsed: boolean;
}

/**
 * Gera 1 imagem tentando primary; on FreepikProviderError.retryable=true (ou similar),
 * cai pra fallback. Cada tentativa emite VisualTraceEntry. Se ambos falham (ou fallback
 * inexiste), retorna { output: null } sem lançar — agent decide graceful degradation.
 */
export async function generateWithFallback(
  agent: VisualAgentName,
  input: GenerateImageInput,
  deps: GenerateWithFallbackDeps,
): Promise<GenerateWithFallbackResult> {
  const traces: VisualTraceEntry[] = [];
  let placeholderUsed = false;

  // Try primary.
  const primaryStarted = Date.now();
  try {
    const output = await deps.primary.generateImage(input);
    traces.push({
      agent,
      provider: deps.primary.name,
      cost_usd: output.cost_usd,
      latency_ms: output.latency_ms,
      tokens_in: output.tokens_in ?? 0,
      tokens_out: output.tokens_out ?? 0,
    });
    return { output, traces, placeholderUsed };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const retryable =
      err instanceof FreepikProviderError ? err.retryable : true;
    traces.push({
      agent,
      provider: deps.primary.name,
      cost_usd: 0,
      latency_ms: Date.now() - primaryStarted,
      error: errMsg,
    });

    if (!retryable || !deps.fallback) {
      return { output: null, traces, placeholderUsed };
    }
  }

  // Try fallback.
  if (!deps.fallback) {
    return { output: null, traces, placeholderUsed };
  }

  const fallbackStarted = Date.now();
  try {
    const output = await deps.fallback.generateImage(input);
    // Detecta uso de placeholder (Higgsfield sem endpoint).
    if (output.provider_meta && output.provider_meta['placeholder'] === true) {
      placeholderUsed = true;
    }
    traces.push({
      agent,
      provider: deps.fallback.name,
      cost_usd: output.cost_usd,
      latency_ms: output.latency_ms,
      tokens_in: output.tokens_in ?? 0,
      tokens_out: output.tokens_out ?? 0,
    });
    return { output, traces, placeholderUsed };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    traces.push({
      agent,
      provider: deps.fallback.name,
      cost_usd: 0,
      latency_ms: Date.now() - fallbackStarted,
      error: errMsg,
    });
    return { output: null, traces, placeholderUsed };
  }
}

/** Parses JSON, tolerating code-fence wrapping. */
export function tryParseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Best-effort slug para placeholder URLs quando prompt precisa virar path. */
export function toSlug(text: string, maxLen = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

/** Suppress unused-warning para HiggsFieldProviderError (re-exportado para consumers). */
export { HiggsFieldProviderError };

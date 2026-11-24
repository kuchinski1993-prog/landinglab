// Iris (@landinglab-lens-scout) — Modo B visual retrieval via SerpAPI Google Lens.
//
// Wave 2 impl: chama searchByImage, retorna top-10 candidatos.
// Empty visual_matches → status 'no_matches' com graceful degradation.

import type { LensVisualMatch, SerpApiClient } from '../providers/serpapi.js';
import type { WorkerOutput } from './types.js';

export interface LensScoutInput {
  sourceImageUrl: string;
  hl?: string;
}

export interface LensScoutData {
  status: 'ok' | 'no_matches';
  candidates: LensVisualMatch[];
}

export async function runLensScout(
  input: LensScoutInput,
  deps: { serpapi: SerpApiClient },
): Promise<WorkerOutput<LensScoutData>> {
  const started = Date.now();
  try {
    const result = await deps.serpapi.searchByImage(input.sourceImageUrl, {
      hl: input.hl ?? 'en',
      topN: 10,
    });
    const status: 'ok' | 'no_matches' = result.visual_matches.length >= 3 ? 'ok' : 'no_matches';
    return {
      data: { status, candidates: result.visual_matches },
      trace: {
        agent: 'lens-scout',
        provider: 'serpapi_google_lens',
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        cost_usd: result.cost_usd,
        latency_ms: result.latency_ms,
        status: status === 'ok' ? 'ok' : 'partial',
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      data: null,
      trace: {
        agent: 'lens-scout',
        provider: 'serpapi_google_lens',
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

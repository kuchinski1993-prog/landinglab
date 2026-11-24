// Squad 1 Orchestrator — Rex (@landinglab-research-lead) real impl.
//
// Wave 2: implementa mode routing (A vs B), fan-out/fan-in via Promise.allSettled
// (custom wrapper — LangGraph OUT per Wave 1 [AUTO-DECISION]), retry por worker,
// timeout global 240s, graceful degradation, cost aggregation.

import type { Database } from '@blackshop/db';

import {
  runLensScout,
  runMarketAnalyst,
  runPirSynthesizer,
  runReviewMiner,
  runSpecHunter,
  runVisionVerifier,
  type ProductExtraction,
  type MarketIntel,
  type LensScoutData,
  type VisionVerifierData,
} from './agents/research-lead.js';
import type { WorkerOutput, TraceEntry } from './agents/types.js';
import type { ApifyClient } from './providers/apify.js';
import type { CheerioClient } from './providers/cheerio.js';
import type { ClaudeVisionClient } from './providers/claude-vision.js';
import type { FirecrawlClient } from './providers/firecrawl.js';
import type { GeminiVisionClient } from './providers/gemini-vision.js';
import type { PerplexityClient } from './providers/perplexity.js';
import type { SerpApiClient } from './providers/serpapi.js';
import type { Pir, Voc } from './schema/pir.js';

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────

const GLOBAL_TIMEOUT_MS = 240_000;
const WORKER_MAX_RETRIES = 2;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;
const VERA_CONFIDENCE_THRESHOLD = 0.6;

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

export interface RunProductResearchInput {
  landingPageId: string;
  targetLanguage: 'de' | 'it' | 'en' | 'es' | 'fr';
  sourceUrl: string | null;
  sourceImageUrl: string | null;
  sourceType: 'aliexpress_link' | 'photo_upload' | 'other_url';
  hint: string | null;
}

export interface RunProductResearchOutput {
  pirDocumentId: string;
  pirVersion: number;
  pir: Pir | null;
  costUsd: number;
  durationMs: number;
  confidenceScore: number;
  mode: 'A' | 'B';
  needsHumanReview?: boolean;
  agentTrace: TraceEntry[];
}

export interface OrchestratorDeps {
  serpapi: SerpApiClient;
  cheerio: CheerioClient;
  firecrawl: FirecrawlClient;
  apify: ApifyClient;
  perplexity: PerplexityClient;
  /**
   * Claude Vision. Usado como fallback do vision-verifier e como cliente
   * principal do pir-synthesizer (Sage), que ainda depende de Opus.
   */
  claude: ClaudeVisionClient;
  /**
   * Gemini Vision (opcional). Quando presente, vision-verifier usa como
   * primary provider (~200x mais barato que Claude Opus) e cai pra Claude
   * apenas se Gemini falhar. Se undefined, cai direto no Claude.
   */
  gemini?: GeminiVisionClient;
  db: Database;
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

export async function runProductResearch(
  input: RunProductResearchInput,
  deps: OrchestratorDeps,
): Promise<RunProductResearchOutput> {
  const started = Date.now();
  const agentTrace: TraceEntry[] = [];
  const mode: 'A' | 'B' = input.sourceImageUrl ? 'B' : 'A';

  // Wrap execução completa num timeout global (240s hard).
  const result = await withGlobalTimeout(
    runInternal(input, deps, agentTrace, mode),
    GLOBAL_TIMEOUT_MS,
  );

  const totalCost = agentTrace.reduce((s, t) => s + (t.cost_usd ?? 0), 0);
  const durationMs = Date.now() - started;

  if (result.status === 'timeout') {
    return {
      pirDocumentId: '',
      pirVersion: 0,
      pir: null,
      costUsd: totalCost,
      durationMs,
      confidenceScore: 0,
      mode,
      needsHumanReview: true,
      agentTrace,
    };
  }
  if (result.status === 'needs_human_review') {
    return {
      pirDocumentId: '',
      pirVersion: 0,
      pir: null,
      costUsd: totalCost,
      durationMs,
      confidenceScore: 0,
      mode,
      needsHumanReview: true,
      agentTrace,
    };
  }

  return {
    pirDocumentId: result.pirDocumentId,
    pirVersion: result.pirVersion,
    pir: result.pir,
    costUsd: totalCost,
    durationMs,
    confidenceScore: result.confidenceScore,
    mode,
    // Bug #10: propaga guard do synthesizer pra processor bloquear Squad 2.
    needsHumanReview: result.status === 'ok' ? result.needsHumanReview : undefined,
    agentTrace,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internal orchestration
// ─────────────────────────────────────────────────────────────────────────

type InternalResult =
  | {
      status: 'ok';
      pirDocumentId: string;
      pirVersion: number;
      pir: Pir;
      confidenceScore: number;
      /** Bug #10: PIR passou Zod mas identity/confidence exige revisão humana. */
      needsHumanReview?: boolean;
    }
  | { status: 'needs_human_review' }
  | { status: 'timeout' }
  | { status: 'synth_failed'; pirDocumentId: string; pirVersion: number; pir: Pir | null; confidenceScore: number };

async function runInternal(
  input: RunProductResearchInput,
  deps: OrchestratorDeps,
  agentTrace: TraceEntry[],
  mode: 'A' | 'B',
): Promise<InternalResult> {
  let effectiveSourceUrl: string | null = input.sourceUrl;
  let visionHint: VisionVerifierData['attributes_extracted'] | null = null;

  // ─── Modo B: lens-scout → vision-verifier sequencial ────────────────────
  if (mode === 'B') {
    if (!input.sourceImageUrl) {
      // Contradição: mode=B mas sem imagem. Marca degradação, tratamos como Modo A.
      // (Este caminho não deveria ocorrer; safeguard.)
    } else {
      const lens = await withRetry(
        () => runLensScout({ sourceImageUrl: input.sourceImageUrl! }, deps),
        'lens-scout',
        agentTrace,
      );
      const lensData: LensScoutData | null = lens.data;
      if (!lensData || lensData.status !== 'ok' || lensData.candidates.length === 0) {
        return { status: 'needs_human_review' };
      }

      const vera = await withRetry(
        () =>
          runVisionVerifier(
            { sourceImageUrl: input.sourceImageUrl!, candidates: lensData.candidates },
            { gemini: deps.gemini, claude: deps.claude },
          ),
        'vision-verifier',
        agentTrace,
      );
      const veraData = vera.data;
      if (!veraData || veraData.confidence < VERA_CONFIDENCE_THRESHOLD) {
        return { status: 'needs_human_review' };
      }
      effectiveSourceUrl = veraData.best_match?.source_url ?? null;
      visionHint = veraData.attributes_extracted;
    }
  }

  // ─── Modo A (ou continuação Modo B): 3 workers paralelos ────────────────
  if (!effectiveSourceUrl) {
    // Modo B sem match verificado (edge case) — tenta apenas market-analyst com hint.
    // Continuamos mesmo assim, gap ficará explícito.
  }

  const specHunterPromise = effectiveSourceUrl
    ? withRetry(
        () =>
          runSpecHunter(
            {
              sourceUrl: effectiveSourceUrl!,
              hint: visionHint?.category ? { category: visionHint.category } : undefined,
            },
            deps,
          ),
        'spec-hunter',
        agentTrace,
      )
    : Promise.resolve<WorkerOutput<ProductExtraction>>({
        data: null,
        trace: {
          agent: 'spec-hunter',
          provider: 'firecrawl_extract',
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          latency_ms: 0,
          status: 'failed',
          error: 'no_source_url_available',
        },
      });

  const reviewMinerPromise = withRetry(
    () =>
      runReviewMiner(
        {
          productTitle: visionHint?.model ?? input.hint ?? input.sourceUrl ?? 'unknown product',
          category: visionHint?.category ?? null,
          brand: visionHint?.brand ?? null,
          sourceUrl: effectiveSourceUrl ?? '',
        },
        deps,
      ),
    'review-miner',
    agentTrace,
  );
  const marketAnalystPromise = withRetry(
    () =>
      runMarketAnalyst(
        {
          productTitle: visionHint?.model ?? input.hint ?? 'unknown product',
          category: visionHint?.category ?? null,
          brand: visionHint?.brand ?? null,
          specs: {},
          targetLanguage: input.targetLanguage,
        },
        deps,
      ),
    'market-analyst',
    agentTrace,
    // market-analyst já retenta internamente (2 calls sequenciais). Reduzir orchestrator
    // retries pra evitar compound hang: 2 internal × 3 orchestrator × 30s = 180s worst case.
    // Com maxRetries=1: 2 internal × 2 orchestrator × 30s = 120s worst case.
    { maxRetries: 1 },
  );

  // Executamos os 3 em paralelo com Promise.allSettled aplicado individualmente
  // (Promise.allSettled em tuple heterogêneo tem tipagem custosa em TS strict —
  //  usamos wrapper individual mais fácil de tipar).
  const [specRes, reviewRes, marketRes] = await Promise.all([
    settle(specHunterPromise),
    settle(reviewMinerPromise),
    settle(marketAnalystPromise),
  ]);

  const specHunterOut: WorkerOutput<ProductExtraction> = specRes.ok
    ? specRes.value
    : failedOutput<ProductExtraction>('spec-hunter', 'firecrawl_extract', specRes.error);
  const reviewMinerOut: WorkerOutput<Voc> = reviewRes.ok
    ? reviewRes.value
    : failedOutput<Voc>('review-miner', 'apify_multi_actor', reviewRes.error);
  const marketAnalystOut: WorkerOutput<MarketIntel> = marketRes.ok
    ? marketRes.value
    : failedOutput<MarketIntel>('market-analyst', 'perplexity_sonar_pro', marketRes.error);

  // ─── Fan-in: Sage synthesizer ────────────────────────────────────────────
  const sage = await runPirSynthesizer(
    {
      landingPageId: input.landingPageId,
      targetLanguage: input.targetLanguage,
      workerOutputs: {
        spec_hunter: specHunterOut,
        review_miner: reviewMinerOut,
        market_analyst: marketAnalystOut,
        // Wave 2: lens/vision não vão pro synthesizer diretamente (Sage
        // usa somente 3 workers de research; lens/vision guiaram effectiveSourceUrl).
      },
    },
    { claude: deps.claude, db: deps.db },
  );

  agentTrace.push(sage.trace);

  if (!sage.data) {
    return {
      status: 'synth_failed',
      pirDocumentId: '',
      pirVersion: 0,
      pir: null,
      confidenceScore: 0,
    };
  }
  return {
    status: 'ok',
    pirDocumentId: sage.data.pirDocumentId,
    pirVersion: sage.data.pirVersion,
    pir: sage.data.pir,
    confidenceScore: sage.data.confidenceScore,
    needsHumanReview: sage.data.needsHumanReview,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Retry wrapper — exponential backoff, base 2s cap 30s.
// ─────────────────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<WorkerOutput<T>>,
  agentName: string,
  trace: TraceEntry[],
  opts?: { maxRetries?: number },
): Promise<WorkerOutput<T>> {
  const maxRetries = opts?.maxRetries ?? WORKER_MAX_RETRIES;
  let lastResult: WorkerOutput<T> | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fn();
      lastResult = res;
      if (res.trace.status !== 'failed') {
        trace.push(res.trace);
        return res;
      }
      // Fail-fast on known non-transient provider errors (rate limits, auth,
      // billing). Retrying wastes global timeout budget without any chance
      // of success within the retry window.
      const errStr = String(res.trace.error ?? '');
      const nonTransient =
        errStr.includes('HTTP 429') ||
        errStr.includes('HTTP 401') ||
        errStr.includes('HTTP 403') ||
        errStr.includes('Rate limit') ||
        errStr.includes('platform-feature-disabled') ||
        errStr.includes('outstanding invoices');
      if (nonTransient) {
        trace.push(res.trace);
        return res;
      }
      // failed → retry se ainda temos tentativas.
      if (attempt < maxRetries) {
        const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, attempt));
        await sleep(delay);
        continue;
      }
    } catch (err) {
      // Erro inesperado (não deveria acontecer — cada worker faz try/catch).
      lastResult = {
        data: null,
        trace: {
          agent: agentName,
          provider: 'unknown',
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          latency_ms: 0,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        },
      };
      if (attempt < maxRetries) {
        await sleep(Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, attempt)));
        continue;
      }
    }
  }
  // Aqui último resultado sempre existe (loop garantiu >=1 iteração).
  trace.push(lastResult!.trace);
  return lastResult!;
}

// ─────────────────────────────────────────────────────────────────────────
// Global timeout wrapper.
// ─────────────────────────────────────────────────────────────────────────

async function withGlobalTimeout(
  inner: Promise<InternalResult>,
  timeoutMs: number,
): Promise<InternalResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<InternalResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });
  try {
    const res = await Promise.race([inner, timeoutPromise]);
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────────────────

// Wrappers pra Promise.allSettled com tipagem simples por-promise.
type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function failedOutput<T>(agent: string, provider: string, error: string): WorkerOutput<T> {
  return {
    data: null,
    trace: {
      agent,
      provider,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      latency_ms: 0,
      status: 'failed',
      error,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sage (@landinglab-pir-synthesizer) — synthesizes PIR from worker outputs.
//
// Wave 2 impl:
//   1. Build LLM prompt with all worker outputs
//   2. Call Claude Opus 4.7 in JSON mode
//   3. Parse + validatePir() (Zod + Article IV guard on evidence.gaps)
//   4. On Zod failure: 1 retry with error injected
//   5. Persist to landing_pir_documents (version = max_existing + 1)

import { desc, eq } from 'drizzle-orm';

import type { ClaudeVisionClient } from '../providers/claude-vision.js';
import { landingPirDocuments, type NewLandingPirDocument } from '@blackshop/db';
import type { Database } from '@blackshop/db';
import { PirValidationError, validatePir, type Pir } from '../schema/pir.js';
import type { WorkerOutput } from './types.js';

// Sage system prompt — canonical from landinglab-pir-synthesizer.md § 5.
// SCHEMA TEMPLATE embedded verbatim to avoid Claude hallucinating field names /
// enum values (e.g. "problem-aware" vs "problem_aware", desired_outcomes as
// array vs object). Every field required by the Zod schema is listed below.
const PIR_JSON_TEMPLATE = `{
  "schema_version": "1.0.0",
  "identity": {
    "name": "<string, required, non-empty>",
    "brand": "<string or null>",
    "category": "<string or null>",
    "model": "<string or null>",
    "price": "<number or null>",
    "currency": "<3-letter uppercase or null>",
    "images": ["<url>"],
    "specs": { "<key>": "<string|number|boolean>" },
    "variants": [{ "name": "<string>", "value": "<string>", "price_delta": <number, optional> }]
  },
  "market": {
    "sophistication_level": <integer 1..5, required>,
    "competitors": [
      { "name": "<string>", "url": "<url or null>", "positioning": "<string or null>", "price_range": "<string or null>", "weakness": "<string or null>" }
    ],
    "trends": ["<string>"],
    "gap_vs_competitors": "<string or null>"
  },
  "avatar": {
    "demographics": {
      "age_range": "<string or null>",
      "gender": "<'male'|'female'|'mixed'|'unknown'>",
      "income_bracket": "<string or null>",
      "geo": ["<string>"]
    },
    "psychographics": {
      "identity": "<string or null>",
      "lifestyle": "<string or null>",
      "beliefs": ["<string>"]
    },
    "jobs_to_be_done": [
      { "job": "<string, solution-free framing>", "importance": <1..10>, "satisfaction": <1..10> }
    ]
  },
  "voc": {
    "language_bank": ["<string>"],
    "top_pains": [{ "pain": "<string>", "frequency": <int>=0>, "intensity": <1..10>, "verbatim": ["<string>"] }],
    "top_desires": [{ "desire": "<string>", "frequency": <int>=0>, "verbatim": ["<string>"] }],
    "top_objections": [{ "objection": "<string>", "frequency": <int>=0>, "verbatim": ["<string>"] }],
    "dream_outcomes": ["<string>"]
  },
  "desired_outcomes": {
    "opportunities": [
      { "outcome": "<string>", "importance": <1..10>, "satisfaction": <1..10>, "opportunity_score": <0..20> }
    ]
  },
  "awareness_stages": [
    {
      "stage": "<one of: unaware | problem_aware | solution_aware | product_aware | most_aware — USE UNDERSCORES, NOT HYPHENS>",
      "trigger_hook": "<string, non-empty>",
      "education_needed": "<string or null>",
      "objections_to_kill": ["<string>"],
      "proof_needed": ["<string>"]
    }
  ],
  "value_equation": {
    "dream_outcome": "<string, non-empty>",
    "perceived_likelihood": <0..1>,
    "time_delay": "<string, non-empty>",
    "effort_sacrifice": "<string, non-empty>"
  },
  "evidence": {
    "reviews_analyzed": <int>=0>,
    "sources": [
      { "agent": "<string>", "provider": "<string>", "url": "<url or null>", "cited_for": "<string, non-empty>" }
    ],
    "confidence_score": <0..1, REQUIRED>,
    "gaps": ["<string, >= 3 chars, MIN 1 ENTRY REQUIRED>"]
  }
}`;

const SYSTEM_PROMPT = `You are a Product Intelligence Analyst applying three frameworks to consolidate research into a Product Intelligence Report (PIR):

1. **Outcome-Driven Innovation (Ulwick):** phrase every job in solution-free form ("minimize the time it takes to X"), score outcomes by importance + (importance - satisfaction).

2. **Schwartz Awareness Stages:** map 5 audience states (unaware → problem_aware → solution_aware → product_aware → most_aware). For each stage, specify: trigger_hook, education_needed, objections_to_kill, proof_needed.

3. **Hormozi Value Equation:** structure as (dream_outcome × perceived_likelihood) ÷ (time_delay × effort_sacrifice).

CRITICAL RULES:
- Fill schema fields ONLY with data actually present in worker outputs. Cite worker source per non-trivial claim in evidence.sources.
- The evidence.gaps field is MANDATORY. List every dimension where data was absent, low-confidence, or contradictory. Never leave it empty. Minimum 1 gap; describe each in a full sentence (>= 3 chars).
- If workerOutputs[X] is null or status=failed, the corresponding PIR section MUST note "gap: worker X did not return data" in evidence.gaps.
- Do NOT invent avatar demographics beyond what market_analyst hypothesized.
- Do NOT invent VOC quotes — reuse only the exact quotes review_miner returned.
- Confidence score: start at 1.0. Subtract 0.1 per missing/partial worker; subtract 0.15 if voc.language_bank is empty; subtract 0.1 if evidence.sources < 3.
- Target audience language (target_language) affects: only which awareness_stages copy hooks/hints are shaped for. Do NOT translate the PIR itself — it's an internal artifact in English.
- awareness_stages.stage MUST use underscores: problem_aware NOT problem-aware. Enum is strict.
- desired_outcomes is an OBJECT with an "opportunities" array — NOT a bare array.
- identity.name is REQUIRED (non-empty string). If workers gave no product name, infer from source_url or hint; if absent even then, use "Unknown Product" and add to evidence.gaps.
- evidence.confidence_score is REQUIRED (0..1 number).

EMIT EXACTLY THIS JSON SHAPE (replace placeholders with real values; keep every key even if value is null or empty array):
${PIR_JSON_TEMPLATE}

Return ONE JSON object matching this exact shape. No prose, no markdown, no code fences.`;

export interface PirSynthesizerInput {
  landingPageId: string;
  targetLanguage: 'de' | 'it' | 'en' | 'es' | 'fr';
  workerOutputs: {
    spec_hunter: WorkerOutput<unknown> | null;
    review_miner: WorkerOutput<unknown> | null;
    market_analyst: WorkerOutput<unknown> | null;
    lens_scout?: WorkerOutput<unknown> | null;
    vision_verifier?: WorkerOutput<unknown> | null;
  };
}

export interface PirSynthesizerData {
  pirDocumentId: string;
  pirVersion: number;
  pir: Pir;
  confidenceScore: number;
  /**
   * When true, Squad 2 (Copy) MUST NOT be dispatched — PIR passou Zod mas
   * carrega sinais fracos (identity.name é placeholder "Unknown Product" ou
   * confidence_score < 0.6). Bug #10: previne vazamento de "Why Unknown Product
   * Delivers..." pra copy final. Requer intervenção humana antes de prosseguir.
   */
  needsHumanReview?: boolean;
  /** Motivo human-readable pra needsHumanReview (logs + UI). */
  blockDownstreamReason?: string;
}

// Threshold pra confidence "low" — abaixo disso Squad 2 é bloqueado.
// TEMP (2026-09-04): baixado de 0.6 → 0.5 pra permitir teste visual da landing
// enquanto cheerio extractor ainda não captura variants (variants=[] penaliza confidence).
// Voltar pra 0.6 quando cheerio pegar variants do Shopify (window.ShopifyAnalytics.meta.product.variants).
const CONFIDENCE_BLOCK_THRESHOLD = 0.5;

/** Result deliberadamente NÃO WorkerOutput — Sage também retorna dados persistidos. */
export interface PirSynthesizerResult {
  data: PirSynthesizerData | null;
  trace: {
    agent: string;
    provider: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    latency_ms: number;
    status: 'ok' | 'partial' | 'failed';
    error?: string;
  };
}

export async function runPirSynthesizer(
  input: PirSynthesizerInput,
  deps: { claude: ClaudeVisionClient; db: Database },
): Promise<PirSynthesizerResult> {
  const started = Date.now();
  const userPayload = buildUserPayload(input);

  let tokens_in = 0;
  let tokens_out = 0;
  let cost_usd = 0;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const systemPrompt =
        attempt === 0
          ? SYSTEM_PROMPT
          : `${SYSTEM_PROMPT}\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n${lastError}\n\nFix the errors above and return a valid PIR JSON matching the Zod schema exactly.`;

      const res = await deps.claude.createMessage({
        model: 'claude-opus-4-7',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPayload }],
        jsonMode: true,
        // NOTE: temperature is deprecated for Opus 4.7 (400 error). Kept here
        // for future models; claude-vision provider strips it for opus-4-7.
        temperature: attempt === 0 ? 0.3 : 0.1,
        maxTokens: 6_000,
        timeoutMs: 75_000,
      });
      tokens_in += res.tokens_in;
      tokens_out += res.tokens_out;
      cost_usd += res.cost_usd;

      const parsed = tryParseJson(res.content);
      if (!parsed) {
        lastError = 'Response was not valid JSON. Return a JSON object only, no prose.';
        continue;
      }

      let pir: Pir;
      try {
        pir = validatePir(parsed);
      } catch (err) {
        if (err instanceof PirValidationError) {
          lastError = err.message;
          continue;
        }
        throw err;
      }

      // Persist com version = max_existing + 1.
      const nextVersion = await computeNextVersion(deps.db, input.landingPageId);
      const insertRow: NewLandingPirDocument = {
        landingPageId: input.landingPageId,
        version: nextVersion,
        content: pir as unknown as NewLandingPirDocument['content'],
        evidenceGaps: pir.evidence.gaps,
        confidenceScore: String(Math.round(pir.evidence.confidence_score * 100) / 100),
        sources: pir.evidence.sources as unknown as NewLandingPirDocument['sources'],
        generatedByAgent: 'pir-synthesizer@opus-4-7',
      };
      const [inserted] = await deps.db
        .insert(landingPirDocuments)
        .values(insertRow)
        .returning({ id: landingPirDocuments.id });
      const id = inserted?.id ?? '';

      // Bug #10 guard: PIR valido (Zod passou) mas identity é placeholder ou
      // confidence baixa → block Squad 2 dispatch pra evitar copy tipo "Why
      // Unknown Product Delivers...". PIR ainda é persistido pra auditoria /
      // permitir humano completar identity e reprocessar.
      const nameLower = pir.identity.name?.toLowerCase() ?? '';
      const identityPlaceholder =
        pir.identity.name === 'Unknown Product' || nameLower.includes('unknown');
      const lowConfidence = pir.evidence.confidence_score < CONFIDENCE_BLOCK_THRESHOLD;
      const needsHumanReview = identityPlaceholder || lowConfidence;
      const blockDownstreamReason = needsHumanReview
        ? `Identity confidence too low (confidence_score=${pir.evidence.confidence_score.toFixed(2)}, name="${pir.identity.name}"). Manual review required before Squad 2 dispatch.`
        : undefined;

      return {
        data: {
          pirDocumentId: id,
          pirVersion: nextVersion,
          pir,
          confidenceScore: pir.evidence.confidence_score,
          needsHumanReview: needsHumanReview || undefined,
          blockDownstreamReason,
        },
        trace: {
          agent: 'pir-synthesizer',
          provider: 'claude_opus_4_7',
          tokens_in,
          tokens_out,
          cost_usd,
          latency_ms: Date.now() - started,
          status: needsHumanReview ? 'partial' : 'ok',
          error: blockDownstreamReason,
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Erros não-Zod (rede, DB) — não vale re-tentar automaticamente aqui;
      // deixamos a segunda iteração tentar uma vez se ainda tiver.
      if (attempt === 1) break;
    }
  }

  return {
    data: null,
    trace: {
      agent: 'pir-synthesizer',
      provider: 'claude_opus_4_7',
      tokens_in,
      tokens_out,
      cost_usd,
      latency_ms: Date.now() - started,
      status: 'failed',
      error: lastError ?? 'unknown_synth_failure',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function buildUserPayload(input: PirSynthesizerInput): string {
  const payload = {
    landingPageId: input.landingPageId,
    targetLanguage: input.targetLanguage,
    workerOutputs: {
      spec_hunter: extractPayload(input.workerOutputs.spec_hunter),
      review_miner: extractPayload(input.workerOutputs.review_miner),
      market_analyst: extractPayload(input.workerOutputs.market_analyst),
      lens_scout: extractPayload(input.workerOutputs.lens_scout ?? null),
      vision_verifier: extractPayload(input.workerOutputs.vision_verifier ?? null),
    },
  };
  return `Synthesize a PIR from the worker outputs below. Emit ONE JSON object matching the PIR schema.\n\n${JSON.stringify(payload, null, 2)}`;
}

function extractPayload(w: WorkerOutput<unknown> | null): { status: string; data: unknown; error?: string } | null {
  if (!w) return null;
  return {
    status: w.trace.status,
    data: w.data,
    error: w.trace.error,
  };
}

function tryParseJson(content: string): unknown {
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

async function computeNextVersion(db: Database, landingPageId: string): Promise<number> {
  // Query: SELECT max(version) FROM landing_pir_documents WHERE landing_page_id = $1
  const rows = await db
    .select({ version: landingPirDocuments.version })
    .from(landingPirDocuments)
    .where(eq(landingPirDocuments.landingPageId, landingPageId))
    .orderBy(desc(landingPirDocuments.version))
    .limit(1);
  const max = rows[0]?.version ?? 0;
  return max + 1;
}


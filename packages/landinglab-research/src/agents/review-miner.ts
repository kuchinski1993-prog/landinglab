// Rita (@landinglab-review-miner) — VOC extraction via Apify Actors.
//
// Wave 2 impl: category → Actor mapping (heurística simples), Promise.allSettled
// dos Actors, filter+score in-agent. Output shape espelha vocSchema.

import type { ApifyClient } from '../providers/apify.js';
import type { Voc } from '../schema/pir.js';
import type { WorkerOutput } from './types.js';

export interface ReviewMinerInput {
  productTitle: string;
  category: string | null;
  brand: string | null;
  sourceUrl: string;
  hints?: {
    known_search_terms?: string[];
    related_subreddits?: string[];
  };
}

/** Actor + input builder por categoria. Simples heurística: DTC/niche vs mainstream. */
interface ActorPlan {
  actorId: string;
  input: Record<string, unknown>;
  source: string; // 'amazon' | 'trustpilot' | 'reddit'
}

function planActors(input: ReviewMinerInput): ActorPlan[] {
  const q = input.productTitle;
  const category = (input.category ?? '').toLowerCase();
  const plans: ActorPlan[] = [];

  // Amazon é sempre viável se produto for físico mainstream (não digital/serviço).
  const digitalHints = ['software', 'saas', 'ebook', 'course', 'app'];
  const isDigital = digitalHints.some((h) => category.includes(h));
  if (!isDigital) {
    plans.push({
      actorId: 'epctex/amazon-reviews-scraper',
      input: {
        search: q,
        maxReviews: 100,
        proxy: { useApifyProxy: true },
      },
      source: 'amazon',
    });
  }

  // Trustpilot só se temos brand.
  if (input.brand && input.brand.trim().length > 0) {
    plans.push({
      actorId: 'apify/trustpilot-reviews-scraper',
      input: {
        companyDomain: input.brand.toLowerCase().replace(/\s+/g, '') + '.com',
        maxReviews: 100,
      },
      source: 'trustpilot',
    });
  }

  // Reddit sempre — subreddits inferidos ou hints.
  const subreddits =
    input.hints?.related_subreddits ??
    inferSubreddits(input.category ?? input.productTitle);
  if (subreddits.length > 0) {
    plans.push({
      actorId: 'apify/reddit-scraper-lite',
      input: {
        searches: subreddits.map((s) => `${s} ${q} review`).slice(0, 3),
        maxItems: 50,
        maxCommentsPerPost: 10,
      },
      source: 'reddit',
    });
  }

  return plans;
}

function inferSubreddits(seed: string): string[] {
  // Heurística mínima: converte categoria em subreddit plausível.
  const cleaned = seed.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const words = cleaned.split(/\s+/).filter((w) => w.length > 3);
  return words.slice(0, 2).map((w) => `r/${w}`);
}

/**
 * Executa Actors em paralelo, tolerante a falhas parciais.
 * Se ao menos 1 Actor retorna >= 5 items, output = 'ok'.
 * Se todos falham → data = null, status = 'failed'.
 */
export async function runReviewMiner(
  input: ReviewMinerInput,
  deps: { apify: ApifyClient },
): Promise<WorkerOutput<Voc>> {
  const started = Date.now();

  // TEMP: Apify Actors (Amazon reviews, Trustpilot, Reddit) precisam de aprovação
  // manual na nova conta Apify (Willblackshop) — smoke test key OK, mas Actors
  // ainda pending review. Retornamos 'partial' com data null pra que Sage marque
  // evidence.gaps refletindo "VOC não coletado" honestamente (Article IV — No Invention).
  // Reativar removendo este bloco quando Actors forem aprovados no console Apify.
  if (process.env['LANDINGLAB_SKIP_APIFY'] === 'true') {
    return {
      data: null,
      trace: {
        agent: 'review-miner',
        provider: 'apify_multi_actor',
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        latency_ms: Date.now() - started,
        status: 'partial',
        error: 'skipped_by_config: LANDINGLAB_SKIP_APIFY=true (apify_actor_approval_pending)',
      },
    };
  }

  const plans = planActors(input);
  if (plans.length === 0) {
    return {
      data: null,
      trace: {
        agent: 'review-miner',
        provider: 'apify_multi_actor',
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        latency_ms: Date.now() - started,
        status: 'failed',
        error: 'no_actor_plan_for_input',
      },
    };
  }

  const results = await Promise.allSettled(
    plans.map(async (plan) => {
      const res = await deps.apify.runActor({
        actorId: plan.actorId,
        input: plan.input,
        timeoutSecs: 100,
      });
      return { plan, res };
    }),
  );

  let totalCost = 0;
  let anySuccess = false;
  let allActorsRejected = true; // rede/HTTP falhou em TODOS
  const allItems: Array<{ source: string; item: Record<string, unknown> }> = [];
  const firstError: string[] = [];

  for (const r of results) {
    if (r.status === 'fulfilled') {
      totalCost += r.value.res.cost_usd;
      allActorsRejected = false; // ao menos um Actor rodou
      if (r.value.res.items.length > 0) {
        anySuccess = true;
        for (const item of r.value.res.items) {
          allItems.push({ source: r.value.plan.source, item: item as Record<string, unknown> });
        }
      }
    } else {
      firstError.push(String(r.reason?.message ?? r.reason ?? 'apify_error'));
    }
  }

  // Só marca 'failed' quando TODOS os Actors deram erro de rede/HTTP.
  // Se rodaram mas devolveram 0 items, retornamos VOC vazio com status 'partial'
  // (produto real pode não ter reviews — não é erro do worker, é gap pro Sage).
  if (allActorsRejected) {
    return {
      data: null,
      trace: {
        agent: 'review-miner',
        provider: 'apify_multi_actor',
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: totalCost,
        latency_ms: Date.now() - started,
        status: 'failed',
        error: firstError.join('; ') || 'all_actors_failed',
      },
    };
  }

  // Post-processing: extrai VOC do mix de items.
  const voc = scoreAndBucket(allItems);
  return {
    data: voc,
    trace: {
      agent: 'review-miner',
      provider: 'apify_multi_actor',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: totalCost,
      latency_ms: Date.now() - started,
      // 'ok' quando temos items; 'partial' quando actors rodaram mas 0 items (produto sem reviews).
      status: anySuccess ? 'ok' : 'partial',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Scoring / bucketing — heurística in-agent (sem LLM).
// ─────────────────────────────────────────────────────────────────────────

function scoreAndBucket(items: Array<{ source: string; item: Record<string, unknown> }>): Voc {
  const painKeywords = ['hate', 'terrible', 'awful', "doesn't work", "didn't work", 'broken', 'waste'];
  const desireKeywords = ['want', 'need', 'wish', 'love', 'perfect', 'exactly what', 'life-changing'];
  const objectionKeywords = ['expensive', 'cheap', 'skeptical', 'too good', 'not sure', 'doubt'];

  const pains = new Map<string, { count: number; verbatim: string[]; intensity: number }>();
  const desires = new Map<string, { count: number; verbatim: string[] }>();
  const objections = new Map<string, { count: number; verbatim: string[] }>();
  const languageBank = new Set<string>();

  for (const { item } of items) {
    const text = pickText(item);
    if (!text) continue;
    const lower = text.toLowerCase();
    const intensity = detectIntensity(text);
    // Simple keyword bucketing.
    for (const kw of painKeywords) {
      if (lower.includes(kw)) {
        upsert(pains, kw, text, intensity);
      }
    }
    for (const kw of desireKeywords) {
      if (lower.includes(kw)) upsertDesire(desires, kw, text);
    }
    for (const kw of objectionKeywords) {
      if (lower.includes(kw)) upsertDesire(objections, kw, text);
    }
    // Language bank: extract 3-6 word ngrams that repeat.
    for (const ngram of extractNgrams(lower, 3, 6)) {
      languageBank.add(ngram);
    }
  }

  return {
    language_bank: Array.from(languageBank).slice(0, 30),
    top_pains: Array.from(pains.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([pain, v]) => ({
        pain,
        frequency: v.count,
        intensity: Math.min(10, v.intensity),
        verbatim: v.verbatim.slice(0, 5),
      })),
    top_desires: Array.from(desires.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([desire, v]) => ({
        desire,
        frequency: v.count,
        verbatim: v.verbatim.slice(0, 5),
      })),
    top_objections: Array.from(objections.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([objection, v]) => ({
        objection,
        frequency: v.count,
        verbatim: v.verbatim.slice(0, 5),
      })),
    dream_outcomes: [],
  };
}

function pickText(item: Record<string, unknown>): string | null {
  const candidates = ['text', 'reviewText', 'body', 'comment', 'title', 'content'];
  for (const key of candidates) {
    const v = item[key];
    if (typeof v === 'string' && v.trim().length > 10) return v;
  }
  return null;
}

function detectIntensity(text: string): number {
  let score = 5;
  const exclaims = (text.match(/!/g) ?? []).length;
  const allCaps = (text.match(/\b[A-Z]{3,}\b/g) ?? []).length;
  score += Math.min(3, exclaims);
  score += Math.min(2, allCaps);
  return Math.min(10, score);
}

function upsert(
  map: Map<string, { count: number; verbatim: string[]; intensity: number }>,
  key: string,
  text: string,
  intensity: number,
): void {
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    if (existing.verbatim.length < 5) existing.verbatim.push(text);
    existing.intensity = Math.max(existing.intensity, intensity);
  } else {
    map.set(key, { count: 1, verbatim: [text], intensity });
  }
}

function upsertDesire(
  map: Map<string, { count: number; verbatim: string[] }>,
  key: string,
  text: string,
): void {
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    if (existing.verbatim.length < 5) existing.verbatim.push(text);
  } else {
    map.set(key, { count: 1, verbatim: [text] });
  }
}

function extractNgrams(text: string, minN: number, maxN: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 2);
  const ngrams: string[] = [];
  for (let n = minN; n <= maxN; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      ngrams.push(words.slice(i, i + n).join(' '));
    }
  }
  return ngrams;
}

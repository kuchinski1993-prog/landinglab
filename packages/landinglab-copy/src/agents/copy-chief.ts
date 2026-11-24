// Copy Chief — orquestrador de assembly + validação + persistência do CopyDeck.
// Story 13.4 AC5 (Wave 2 dispatch), AC15, AC19, AC20, AC21.
//
// Flow:
//   1. Recebe 5 CopyWorkerOutputs (Hormozi, Schwartz, Halbert, Cialdini, Voss).
//   2. Chama Claude Opus com Copy Chief system prompt + JSON blob dos outputs.
//   3. Parse + validateCopyDeck() (Zod). Se falhar, retenta 1x com errors injetados.
//   4. Fallback voc_verbatim: se < 3 e pir.voc.language_bank tem entries, injeta.
//   5. Persiste em landing_copy_decks (INSERT com version = max_existing + 1).
//   6. Retorna { copyDeckId, copyDeck, cost_usd, trace, chiefNotes }.

import { desc, eq, and } from 'drizzle-orm';

import { landingCopyDecks, type NewLandingCopyDeck } from '@blackshop/db';
import type { Database } from '@blackshop/db';
import type { Pir } from '@blackshop/landinglab-research';

import { buildCopyChiefSystemPrompt } from '../prompts/copy-chief.js';
import type { ClaudeTextClient } from '../providers/claude.js';
import {
  CopyDeckValidationError,
  validateCopyDeck,
  type CopyDeck,
} from '../schema/copy-deck.js';
import { tryParseJson } from './shared.js';
import type { CopyContributions, CopyTraceEntry, CopyWorkerOutput } from './types.js';

export interface CopyChiefInput {
  landingPageId: string;
  pirDocumentId: string;
  pir: Pir;
  language: 'en' | 'de' | 'it' | 'fr' | 'es';
  workerOutputs: CopyWorkerOutput[];
}

export interface CopyChiefDeps {
  claude: ClaudeTextClient;
  db: Database;
}

export interface CopyChiefResult {
  copyDeckId: string;
  copyDeck: CopyDeck;
  chiefNotes: string;
  trace: CopyTraceEntry;
}

export async function runCopyChief(
  input: CopyChiefInput,
  deps: CopyChiefDeps,
): Promise<CopyChiefResult> {
  const started = Date.now();
  const usableWorkers = input.workerOutputs.filter((w) => w.trace.status === 'ok');
  const contributingAgents = buildContributingAgents(usableWorkers);

  // Aggregate voc_verbatim from all workers (deduplicated).
  const aggregatedVerbatim = dedupeVerbatim(
    usableWorkers.flatMap((w) => w.contributions.voc_verbatim_used ?? []),
  );

  const userPayload = buildUserPayload(input, usableWorkers);

  let tokens_in = 0;
  let tokens_out = 0;
  let cost_usd = 0;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const systemPrompt = buildCopyChiefSystemPrompt(input.language, input.pir, lastError);

    let res;
    try {
      res = await deps.claude.createMessage({
        system: systemPrompt,
        messages: [{ role: 'user', content: userPayload }],
        jsonMode: true,
        temperature: attempt === 0 ? 0.4 : 0.2,
        maxTokens: 8_000,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 1) break;
      continue;
    }
    tokens_in += res.tokens_in;
    tokens_out += res.tokens_out;
    cost_usd += res.cost_usd;

    const parsed = tryParseJson(res.content);
    if (!parsed || typeof parsed !== 'object') {
      lastError = 'Response was not valid JSON. Return a single JSON object matching the CopyDeck schema.';
      continue;
    }

    const parsedObj = parsed as Record<string, unknown>;
    const chiefNotesRaw = typeof parsedObj['chief_notes'] === 'string' ? parsedObj['chief_notes'] : '';

    // Strip chief_notes before validation.
    const deckCandidate: Record<string, unknown> = { ...parsedObj };
    delete deckCandidate['chief_notes'];

    // Fallback #1: Article IV third layer — inject verbatim from PIR if underdelivered.
    const providedVerbatim = Array.isArray(deckCandidate['voc_verbatim_used'])
      ? (deckCandidate['voc_verbatim_used'] as unknown[]).filter(
          (v): v is string => typeof v === 'string',
        )
      : [];
    let fallbackUsed = false;
    if (providedVerbatim.length < 3 && input.pir.voc.language_bank.length > 0) {
      const merged = dedupeVerbatim([
        ...providedVerbatim,
        ...aggregatedVerbatim,
        ...input.pir.voc.language_bank,
      ]);
      deckCandidate['voc_verbatim_used'] = merged.slice(0, Math.max(3, providedVerbatim.length + 3));
      fallbackUsed = true;
    }

    try {
      let copyDeck = validateCopyDeck(deckCandidate);
      if (!copyDeck.contributing_agents || copyDeck.contributing_agents.length === 0) {
        copyDeck = { ...copyDeck, contributing_agents: contributingAgents };
      }
      const notes = chiefNotesRaw || buildFallbackChiefNotes(usableWorkers, fallbackUsed);

      // Persist.
      const nextVersion = await computeNextVersion(deps.db, input.landingPageId, input.language);
      const insertRow: NewLandingCopyDeck = {
        landingPageId: input.landingPageId,
        pirDocumentId: input.pirDocumentId,
        language: input.language,
        version: nextVersion,
        content: copyDeck as unknown as NewLandingCopyDeck['content'],
        contributingAgents:
          copyDeck.contributing_agents as unknown as NewLandingCopyDeck['contributingAgents'],
        costUsd: String(Math.round(cost_usd * 10000) / 10000),
        chiefNotes: notes,
        generatedByAgent: 'landinglab-copy-chief@opus-4-7',
      };
      const [inserted] = await deps.db
        .insert(landingCopyDecks)
        .values(insertRow)
        .returning({ id: landingCopyDecks.id });
      const id = inserted?.id ?? '';

      return {
        copyDeckId: id,
        copyDeck,
        chiefNotes: notes,
        trace: {
          agent: 'copy-chief',
          provider: 'anthropic',
          tokens_in,
          tokens_out,
          cost_usd,
          latency_ms: Date.now() - started,
          status: 'ok',
        },
      };
    } catch (err) {
      if (err instanceof CopyDeckValidationError) {
        lastError = err.message;
        continue;
      }
      throw err;
    }
  }

  throw new CopyDeckValidationError(
    `Copy Chief could not produce a valid CopyDeck after 2 attempts. Last error:\n${lastError ?? 'unknown'}`,
    [],
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function buildUserPayload(input: CopyChiefInput, usableWorkers: CopyWorkerOutput[]): string {
  const byAgent: Record<string, CopyContributions> = {};
  for (const w of usableWorkers) {
    byAgent[w.agent] = w.contributions;
  }
  const failedAgents = input.workerOutputs
    .filter((w) => w.trace.status === 'failed')
    .map((w) => ({ agent: w.agent, error: w.trace.error ?? 'unknown' }));

  const payload = {
    landingPageId: input.landingPageId,
    language: input.language,
    productName: input.pir.identity.name,
    dreamOutcome: input.pir.value_equation.dream_outcome,
    languageBankSample: input.pir.voc.language_bank.slice(0, 20),
    topObjections: input.pir.voc.top_objections.slice(0, 6).map((o) => o.objection),
    workerContributions: byAgent,
    failedAgents,
  };
  return `Assemble the final CopyDeck. Below are the raw contributions from 5 copywriter agents plus PIR anchors. Follow block selection rules from the system prompt. Enforce voc_verbatim_used >= 3 with fallback from languageBankSample if needed.\n\n${JSON.stringify(payload, null, 2)}`;
}

function buildContributingAgents(
  usableWorkers: CopyWorkerOutput[],
): CopyDeck['contributing_agents'] {
  const entries: CopyDeck['contributing_agents'] = [];
  for (const w of usableWorkers) {
    for (const block of Object.keys(w.contributions)) {
      if (block === 'voc_verbatim_used') continue;
      entries.push({ block, agent: w.agent, confidence: 0.8 });
    }
  }
  return entries;
}

function buildFallbackChiefNotes(
  usableWorkers: CopyWorkerOutput[],
  fallbackUsed: boolean,
): string {
  const ok = usableWorkers.map((w) => w.agent).join(', ') || 'none';
  const parts = [
    `Assembled deck using contributions from: ${ok}.`,
    fallbackUsed
      ? 'voc_verbatim fallback triggered — pulled additional entries from pir.voc.language_bank.'
      : '',
  ].filter(Boolean);
  return parts.join(' ');
}

function dedupeVerbatim(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length < 3) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

async function computeNextVersion(
  db: Database,
  landingPageId: string,
  language: string,
): Promise<number> {
  const rows = await db
    .select({ version: landingCopyDecks.version })
    .from(landingCopyDecks)
    .where(
      and(
        eq(landingCopyDecks.landingPageId, landingPageId),
        eq(landingCopyDecks.language, language),
      ),
    )
    .orderBy(desc(landingCopyDecks.version))
    .limit(1);
  const max = rows[0]?.version ?? 0;
  return max + 1;
}

// runCopySquad — orquestrador do Squad 2 (Copy High-Conversion). Wave 2 real impl.
//
// Flow:
//   1. Load PIR from DB (via pirDocumentId) if not provided in input, parse via pirSchema.
//      (Preferred path: caller/worker passes `pir` already parsed to avoid double-query.)
//   2. Fan-out: 5 copywriters in parallel with Promise.allSettled + per-worker retry.
//   3. Global timeout: 240s hard.
//   4. Fan-in: Copy Chief assembles + validates + persists deck (its own 1x retry).
//   5. Return { copyDeckId, copyDeck, costUsd, durationMs, agentTrace, language }.
//
// [AUTO-DECISION] Multi-language execution: Option B — this orchestrator handles
// ONE language per call. Worker processor (Wave 3) loops over target_languages
// sequentially. Rationale: simpler unit tests, aligns with Squad 1 pattern
// (Squad 1 orchestrator also handles single targetLanguage).
//
// [AUTO-DECISION] Global limiter (1 execution / 60s) lives at BullMQ layer
// (Wave 3 config), not orchestrator. Keeps orchestrator pure/stateless.

import { eq } from 'drizzle-orm';

import type { Database } from '@blackshop/db';
import { landingPirDocuments } from '@blackshop/db';
import { pirSchema, type Pir } from '@blackshop/landinglab-research';

import { runCialdiniAgent } from './agents/cialdini.js';
import { runCopyChief, type CopyChiefResult } from './agents/copy-chief.js';
import { runHalbertAgent } from './agents/halbert.js';
import { runHormoziAgent } from './agents/hormozi.js';
import { makeFailedCopyWorkerOutput, type CopyTraceEntry, type CopyWorkerOutput } from './agents/types.js';
import { runSchwartzAgent } from './agents/schwartz.js';
import { runVossAgent } from './agents/voss.js';
import type { ClaudeTextClient } from './providers/claude.js';
import type { CopyDeck } from './schema/copy-deck.js';

// ─── Config ──────────────────────────────────────────────────────────────

const GLOBAL_TIMEOUT_MS = 240_000;
const WORKER_MAX_RETRIES = 2;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;

// ─── Public types ────────────────────────────────────────────────────────

export interface RunCopySquadInput {
  landingPageId: string;
  pirDocumentId: string;
  /** Optional pre-loaded PIR (avoids DB round-trip if caller already fetched it). */
  pir?: Pir;
  language: 'en' | 'de' | 'it' | 'fr' | 'es';
  previousRunId?: string;
}

export type { CopyTraceEntry };

export interface RunCopySquadOutput {
  copyDeckId: string;
  copyDeck: CopyDeck;
  costUsd: number;
  durationMs: number;
  agentTrace: CopyTraceEntry[];
  chiefNotes: string;
  language: RunCopySquadInput['language'];
  mode: 'copy';
}

export interface CopySquadDeps {
  claude: ClaudeTextClient;
  db: Database;
  now?: () => Date;
}

// ─── Entry point ─────────────────────────────────────────────────────────

export async function runCopySquad(
  input: RunCopySquadInput,
  deps: CopySquadDeps,
): Promise<RunCopySquadOutput> {
  const started = Date.now();
  const agentTrace: CopyTraceEntry[] = [];

  const inner = runInternal(input, deps, agentTrace);
  const result = await withGlobalTimeout(inner, GLOBAL_TIMEOUT_MS);

  if (result.status === 'timeout') {
    throw new Error(
      `runCopySquad timed out after ${GLOBAL_TIMEOUT_MS}ms for landingPage=${input.landingPageId} language=${input.language}`,
    );
  }
  if (result.status === 'error') {
    throw result.error;
  }

  const totalCost = agentTrace.reduce((s, t) => s + (t.cost_usd ?? 0), 0);
  return {
    copyDeckId: result.chief.copyDeckId,
    copyDeck: result.chief.copyDeck,
    costUsd: totalCost,
    durationMs: Date.now() - started,
    agentTrace,
    chiefNotes: result.chief.chiefNotes,
    language: input.language,
    mode: 'copy',
  };
}

// ─── Internal flow ───────────────────────────────────────────────────────

type InternalResult =
  | { status: 'ok'; chief: CopyChiefResult }
  | { status: 'timeout' }
  | { status: 'error'; error: Error };

async function runInternal(
  input: RunCopySquadInput,
  deps: CopySquadDeps,
  agentTrace: CopyTraceEntry[],
): Promise<InternalResult> {
  try {
    // 1. Load PIR if not provided.
    const pir = input.pir ?? (await loadPirFromDb(deps.db, input.pirDocumentId));

    // 2. Fan-out with per-agent retry.
    const hormoziPromise = withRetry(
      () => runHormoziAgent(pir, input.language, { claude: deps.claude }),
      'hormozi',
      agentTrace,
    );
    const schwartzPromise = withRetry(
      () => runSchwartzAgent(pir, input.language, { claude: deps.claude }),
      'schwartz',
      agentTrace,
    );
    const halbertPromise = withRetry(
      () => runHalbertAgent(pir, input.language, { claude: deps.claude }),
      'halbert',
      agentTrace,
    );
    const cialdiniPromise = withRetry(
      () => runCialdiniAgent(pir, input.language, { claude: deps.claude }),
      'cialdini',
      agentTrace,
    );
    const vossPromise = withRetry(
      () => runVossAgent(pir, input.language, { claude: deps.claude }),
      'voss',
      agentTrace,
    );

    const settled = await Promise.allSettled([
      hormoziPromise,
      schwartzPromise,
      halbertPromise,
      cialdiniPromise,
      vossPromise,
    ]);

    const outputs: CopyWorkerOutput[] = [
      unpack(settled[0], 'hormozi'),
      unpack(settled[1], 'schwartz'),
      unpack(settled[2], 'halbert'),
      unpack(settled[3], 'cialdini'),
      unpack(settled[4], 'voss'),
    ];

    // 3. Fan-in: Copy Chief.
    const chief = await runCopyChief(
      {
        landingPageId: input.landingPageId,
        pirDocumentId: input.pirDocumentId,
        pir,
        language: input.language,
        workerOutputs: outputs,
      },
      { claude: deps.claude, db: deps.db },
    );
    agentTrace.push(chief.trace);

    return { status: 'ok', chief };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

// ─── DB / PIR loading ────────────────────────────────────────────────────

async function loadPirFromDb(db: Database, pirDocumentId: string): Promise<Pir> {
  const rows = await db
    .select({ content: landingPirDocuments.content })
    .from(landingPirDocuments)
    .where(eq(landingPirDocuments.id, pirDocumentId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`PIR document not found: ${pirDocumentId}`);
  }
  return pirSchema.parse(row.content);
}

// ─── Retry wrapper ──────────────────────────────────────────────────────

async function withRetry(
  fn: () => Promise<CopyWorkerOutput>,
  agentName: CopyWorkerOutput['agent'],
  trace: CopyTraceEntry[],
): Promise<CopyWorkerOutput> {
  let last: CopyWorkerOutput | null = null;
  for (let attempt = 0; attempt <= WORKER_MAX_RETRIES; attempt++) {
    try {
      const res = await fn();
      last = res;
      if (res.trace.status !== 'failed') {
        trace.push(res.trace);
        return res;
      }
      if (attempt < WORKER_MAX_RETRIES) {
        await sleep(Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, attempt)));
        continue;
      }
    } catch (err) {
      last = makeFailedCopyWorkerOutput(agentName, err instanceof Error ? err.message : String(err));
      if (attempt < WORKER_MAX_RETRIES) {
        await sleep(Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, attempt)));
        continue;
      }
    }
  }
  trace.push(last!.trace);
  return last!;
}

function unpack(
  settled: PromiseSettledResult<CopyWorkerOutput>,
  agentName: CopyWorkerOutput['agent'],
): CopyWorkerOutput {
  if (settled.status === 'fulfilled') return settled.value;
  return makeFailedCopyWorkerOutput(
    agentName,
    settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
  );
}

// ─── Global timeout wrapper ─────────────────────────────────────────────

async function withGlobalTimeout(
  inner: Promise<InternalResult>,
  timeoutMs: number,
): Promise<InternalResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<InternalResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([inner, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

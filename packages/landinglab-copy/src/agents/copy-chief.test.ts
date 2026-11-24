// Copy Chief tests — assembly + fallback + Zod retry + persistence.

import { describe, expect, it, vi } from 'vitest';

import type { Database } from '@blackshop/db';

import { makeValidCopyDeck } from '../__fixtures__/copy-deck.js';
import { makeValidPir } from '../__fixtures__/pir.js';
import type { ClaudeTextClient, ClaudeTextMessagesResult } from '../providers/claude.js';
import { runCopyChief } from './copy-chief.js';
import type { CopyWorkerOutput } from './types.js';

// ─── Mock helpers ────────────────────────────────────────────────────────

function makeScriptedClaude(responses: string[]): {
  client: ClaudeTextClient;
  calls: Array<{ system: string; user: string }>;
} {
  const calls: Array<{ system: string; user: string }> = [];
  let idx = 0;
  const client: ClaudeTextClient = {
    async createMessage(opts) {
      calls.push({
        system: opts.system,
        user: opts.messages[0]?.content ?? '',
      });
      const content = responses[idx] ?? responses[responses.length - 1] ?? '{}';
      idx++;
      const result: ClaudeTextMessagesResult = {
        content,
        tokens_in: 100,
        tokens_out: 200,
        latency_ms: 50,
        cost_usd: 0.01,
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
      };
      return result;
    },
  };
  return { client, calls };
}

interface MockDbState {
  insertedRows: unknown[];
  existingVersions: Map<string, number>;
}

function makeMockDb(state: MockDbState = { insertedRows: [], existingVersions: new Map() }): {
  db: Database;
  state: MockDbState;
} {
  const db = {
    select: (_cols?: unknown) => {
      const chain = {
        from: (_table: unknown) => ({
          where: (_pred: unknown) => ({
            orderBy: (_ord: unknown) => ({
              limit: async (_n: number) => {
                const versions = Array.from(state.existingVersions.values());
                if (versions.length === 0) return [];
                const max = Math.max(...versions);
                return [{ version: max }];
              },
            }),
          }),
        }),
      };
      return chain;
    },
    insert: (_table: unknown) => ({
      values: (row: unknown) => ({
        returning: async (_cols: unknown) => {
          state.insertedRows.push(row);
          return [{ id: `deck-${state.insertedRows.length}` }];
        },
      }),
    }),
  } as unknown as Database;
  return { db, state };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('runCopyChief — happy path', () => {
  it('assembles deck from 5 worker outputs and persists it', async () => {
    const pir = makeValidPir();
    const validDeckJson = JSON.stringify({
      ...makeValidCopyDeck(),
      chief_notes: 'Test-scripted assembly. All 5 agents contributed.',
    });
    const { client } = makeScriptedClaude([validDeckJson]);
    const { db, state } = makeMockDb();

    const workerOutputs: CopyWorkerOutput[] = [
      makeOkWorker('hormozi'),
      makeOkWorker('schwartz'),
      makeOkWorker('halbert'),
      makeOkWorker('cialdini'),
      makeOkWorker('voss'),
    ];

    const result = await runCopyChief(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        pir,
        language: 'en',
        workerOutputs,
      },
      { claude: client, db },
    );

    expect(result.copyDeckId).toBe('deck-1');
    expect(result.copyDeck.hooks).toHaveLength(3);
    expect(result.chiefNotes).toContain('assembly');
    expect(result.trace.status).toBe('ok');
    expect(state.insertedRows).toHaveLength(1);
  });
});

describe('runCopyChief — Zod retry (attempt 1 invalid, attempt 2 valid)', () => {
  it('retries once when first response fails schema validation', async () => {
    const pir = makeValidPir();
    // Attempt 1: invalid (voc_verbatim_used only 1 entry, PIR has language_bank so fallback kicks in).
    // Use empty language_bank in a separate PIR to force real Zod failure without fallback masking.
    const pirEmptyBank = makeValidPir({
      voc: {
        language_bank: [],
        top_pains: pir.voc.top_pains,
        top_desires: pir.voc.top_desires,
        top_objections: pir.voc.top_objections,
        dream_outcomes: pir.voc.dream_outcomes,
      },
    });
    const invalidDeck = { ...makeValidCopyDeck(), voc_verbatim_used: [] };
    const validDeck = { ...makeValidCopyDeck(), chief_notes: 'Retry succeeded.' };

    const { client, calls } = makeScriptedClaude([
      JSON.stringify(invalidDeck),
      JSON.stringify(validDeck),
    ]);
    const { db } = makeMockDb();

    const result = await runCopyChief(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        pir: pirEmptyBank,
        language: 'en',
        workerOutputs: [makeOkWorker('hormozi'), makeOkWorker('voss')],
      },
      { claude: client, db },
    );

    expect(result.copyDeck.hooks).toHaveLength(3);
    expect(calls).toHaveLength(2);
    // Second attempt's system prompt must include the previous error.
    expect(calls[1]!.system).toMatch(/PREVIOUS ATTEMPT FAILED VALIDATION/);
  });
});

describe('runCopyChief — voc_verbatim fallback (Article IV third layer)', () => {
  it('injects verbatim from pir.voc.language_bank when workers underdelivered', async () => {
    const pir = makeValidPir();
    // Deck with only 1 verbatim — Chief must fallback (PIR has 5 in language_bank).
    const underDeliveredDeck = {
      ...makeValidCopyDeck(),
      voc_verbatim_used: ['only one'],
    };
    const { client } = makeScriptedClaude([JSON.stringify(underDeliveredDeck)]);
    const { db, state } = makeMockDb();

    const result = await runCopyChief(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        pir,
        language: 'en',
        workerOutputs: [makeOkWorker('halbert', { voc_verbatim_used: [] })],
      },
      { claude: client, db },
    );

    expect(result.copyDeck.voc_verbatim_used.length).toBeGreaterThanOrEqual(3);
    // Should include something from PIR language_bank.
    const merged = result.copyDeck.voc_verbatim_used;
    const fromPir = pir.voc.language_bank.some((entry) => merged.includes(entry));
    expect(fromPir).toBe(true);
    expect(result.chiefNotes).toMatch(/fallback|Assembled/);
    expect(state.insertedRows).toHaveLength(1);
  });
});

describe('runCopyChief — throws after both attempts fail', () => {
  it('surfaces CopyDeckValidationError when 2 attempts fail and PIR bank is empty', async () => {
    const pirEmpty = makeValidPir({
      voc: {
        language_bank: [],
        top_pains: [],
        top_desires: [],
        top_objections: [],
        dream_outcomes: [],
      },
    });
    const invalid = JSON.stringify({ ...makeValidCopyDeck(), voc_verbatim_used: [] });
    const { client } = makeScriptedClaude([invalid, invalid]);
    const { db } = makeMockDb();

    await expect(
      runCopyChief(
        {
          landingPageId: 'lp-1',
          pirDocumentId: 'pir-1',
          pir: pirEmpty,
          language: 'en',
          workerOutputs: [makeOkWorker('hormozi')],
        },
        { claude: client, db },
      ),
    ).rejects.toThrow(/could not produce a valid CopyDeck/);
  });
});

describe('runCopyChief — contributing_agents backfill', () => {
  it('populates contributing_agents when chief omits them', async () => {
    const pir = makeValidPir();
    const deckNoAgents = { ...makeValidCopyDeck(), contributing_agents: [] };
    const { client } = makeScriptedClaude([JSON.stringify(deckNoAgents)]);
    const { db } = makeMockDb();

    const result = await runCopyChief(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        pir,
        language: 'en',
        workerOutputs: [
          makeOkWorker('hormozi', { offer_stack: makeValidCopyDeck().offer_stack }),
          makeOkWorker('voss', { faq: makeValidCopyDeck().faq }),
        ],
      },
      { claude: client, db },
    );

    expect(result.copyDeck.contributing_agents.length).toBeGreaterThan(0);
  });
});

describe('runCopyChief — version calculation', () => {
  it('inserts version 1 when no prior versions exist', async () => {
    const pir = makeValidPir();
    const { client } = makeScriptedClaude([JSON.stringify(makeValidCopyDeck())]);
    const { db, state } = makeMockDb();

    await runCopyChief(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        pir,
        language: 'en',
        workerOutputs: [makeOkWorker('hormozi')],
      },
      { claude: client, db },
    );

    const inserted = state.insertedRows[0] as { version: number };
    expect(inserted.version).toBe(1);
  });

  it('increments version when prior versions exist', async () => {
    const pir = makeValidPir();
    const { client } = makeScriptedClaude([JSON.stringify(makeValidCopyDeck())]);
    const { db, state } = makeMockDb();
    state.existingVersions.set('lp-1:en', 3);

    await runCopyChief(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        pir,
        language: 'en',
        workerOutputs: [makeOkWorker('hormozi')],
      },
      { claude: client, db },
    );

    const inserted = state.insertedRows[0] as { version: number };
    expect(inserted.version).toBe(4);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeOkWorker(
  agent: CopyWorkerOutput['agent'],
  contribOverrides: Partial<CopyWorkerOutput['contributions']> = {},
): CopyWorkerOutput {
  return {
    agent,
    contributions: {
      voc_verbatim_used: ['sample verbatim from worker'],
      ...contribOverrides,
    },
    trace: {
      agent,
      provider: 'anthropic',
      tokens_in: 100,
      tokens_out: 200,
      cost_usd: 0.01,
      latency_ms: 50,
      status: 'ok',
    },
  };
}

// Silence unused-import warning in strict TS if vi is unused.
void vi;

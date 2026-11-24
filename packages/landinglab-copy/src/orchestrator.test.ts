// Orchestrator tests — happy path, graceful degradation, cost aggregation.
//
// Strategy: script the Claude client so it returns different JSON per call.
// The orchestrator calls each of the 5 copywriters (each 1-2 Claude calls
// depending on retry), plus the Chief. We identify which agent is being
// invoked by inspecting the system prompt content.

import { describe, expect, it } from 'vitest';

import type { Database } from '@blackshop/db';

import { makeValidCopyDeck } from './__fixtures__/copy-deck.js';
import { makeValidPir } from './__fixtures__/pir.js';
import type { ClaudeTextClient, ClaudeTextMessagesResult } from './providers/claude.js';
import { runCopySquad } from './orchestrator.js';

// ─── Router: system-prompt content → agent responder ─────────────────────

interface AgentResponses {
  hormozi: () => string;
  schwartz: () => string;
  halbert: () => string;
  cialdini: () => string;
  voss: () => string;
  chief: () => string;
}

function makeRoutedClaude(
  responses: AgentResponses,
  costPerCall = 0.01,
): { client: ClaudeTextClient; callCount: () => number } {
  let calls = 0;
  const client: ClaudeTextClient = {
    async createMessage(opts) {
      calls++;
      const sys = opts.system;
      let content: string;
      if (sys.includes('HORMOZI copywriter')) content = responses.hormozi();
      else if (sys.includes('SCHWARTZ copywriter')) content = responses.schwartz();
      else if (sys.includes('HALBERT copywriter')) content = responses.halbert();
      else if (sys.includes('CIALDINI copywriter')) content = responses.cialdini();
      else if (sys.includes('VOSS copywriter')) content = responses.voss();
      else if (sys.includes('COPY CHIEF')) content = responses.chief();
      else content = '{}';
      const result: ClaudeTextMessagesResult = {
        content,
        tokens_in: 500,
        tokens_out: 800,
        latency_ms: 50,
        cost_usd: costPerCall,
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
      };
      return result;
    },
  };
  return { client, callCount: () => calls };
}

function makeMockDb(): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [],
          }),
          limit: async () => [],
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: 'deck-1' }],
      }),
    }),
  } as unknown as Database;
}

// ─── Agent output builders (JSON strings) ────────────────────────────────

const HORMOZI_OK = () =>
  JSON.stringify({
    offer_stack: makeValidCopyDeck().offer_stack,
    urgency_copy: 'Bonus expires when this batch ships out this Friday.',
    guarantee:
      '60-day no-questions-asked full refund. If you don\'t feel a difference in 30 days, we refund you.',
    benefit_bullets: makeValidCopyDeck().benefit_bullets.slice(0, 5),
    voc_verbatim_used: ['my back was killing me by 3pm every single day'],
  });

const SCHWARTZ_OK = () =>
  JSON.stringify({
    hooks: makeValidCopyDeck().hooks,
    subheadlines: makeValidCopyDeck().subheadlines,
    voc_verbatim_used: [],
  });

const HALBERT_OK = () =>
  JSON.stringify({
    subheadlines: ['A gentle nudge back into alignment — every 45 minutes at your desk.'],
    benefit_bullets: makeValidCopyDeck().benefit_bullets.slice(0, 5),
    voc_verbatim_used: [
      'my back was killing me by 3pm every single day',
      "I don't want to take pills anymore",
      'chiropractor is too expensive to do weekly',
    ],
  });

const CIALDINI_OK = () =>
  JSON.stringify({
    social_proof_blocks: makeValidCopyDeck().social_proof_blocks,
    ctas: makeValidCopyDeck().ctas,
    voc_verbatim_used: [],
  });

const VOSS_OK = () =>
  JSON.stringify({
    faq: makeValidCopyDeck().faq,
    voc_verbatim_used: ['nothing else has worked'],
  });

const CHIEF_OK = () =>
  JSON.stringify({
    ...makeValidCopyDeck(),
    chief_notes: 'Assembled deck from 5 agents.',
  });

// ─── Tests ───────────────────────────────────────────────────────────────

describe('runCopySquad — happy path', () => {
  it('runs all 5 copywriters + chief and returns a validated deck', async () => {
    const { client, callCount } = makeRoutedClaude({
      hormozi: HORMOZI_OK,
      schwartz: SCHWARTZ_OK,
      halbert: HALBERT_OK,
      cialdini: CIALDINI_OK,
      voss: VOSS_OK,
      chief: CHIEF_OK,
    });
    const db = makeMockDb();
    const pir = makeValidPir();

    const result = await runCopySquad(
      {
        landingPageId: 'lp-1',
        pirDocumentId: 'pir-1',
        pir,
        language: 'en',
      },
      { claude: client, db },
    );

    expect(result.copyDeckId).toBe('deck-1');
    expect(result.language).toBe('en');
    expect(result.mode).toBe('copy');
    expect(result.copyDeck.hooks).toHaveLength(3);
    expect(result.agentTrace.length).toBeGreaterThanOrEqual(5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // 5 workers + 1 chief = 6 Claude calls (assuming no retries).
    expect(callCount()).toBe(6);
  });

  it('aggregates cost across all agent traces', async () => {
    const costPerCall = 0.05;
    const { client } = makeRoutedClaude(
      {
        hormozi: HORMOZI_OK,
        schwartz: SCHWARTZ_OK,
        halbert: HALBERT_OK,
        cialdini: CIALDINI_OK,
        voss: VOSS_OK,
        chief: CHIEF_OK,
      },
      costPerCall,
    );
    const result = await runCopySquad(
      { landingPageId: 'lp-1', pirDocumentId: 'pir-1', pir: makeValidPir(), language: 'en' },
      { claude: client, db: makeMockDb() },
    );

    // Traces: 5 workers + 1 chief, each contributed one Claude call.
    expect(result.costUsd).toBeCloseTo(costPerCall * 6, 4);
  });
});

describe('runCopySquad — graceful degradation', () => {
  it('proceeds when 1 copywriter fails (Cialdini fails, chief compensates)', async () => {
    // Cialdini returns invalid JSON on both attempts → orchestrator retries + eventually marks failed.
    // Chief still runs with remaining 4 outputs.
    const { client } = makeRoutedClaude({
      hormozi: HORMOZI_OK,
      schwartz: SCHWARTZ_OK,
      halbert: HALBERT_OK,
      cialdini: () => 'not json at all',
      voss: VOSS_OK,
      // Chief must return a deck INCLUDING CTAs (which Cialdini would've supplied).
      chief: CHIEF_OK,
    });
    const db = makeMockDb();

    const result = await runCopySquad(
      { landingPageId: 'lp-1', pirDocumentId: 'pir-1', pir: makeValidPir(), language: 'en' },
      { claude: client, db },
    );

    expect(result.copyDeckId).toBe('deck-1');
    expect(result.copyDeck.ctas).toHaveLength(3);
    // Cialdini's trace should be 'failed'.
    const cialdiniTrace = result.agentTrace.find((t) => t.agent === 'cialdini');
    expect(cialdiniTrace?.status).toBe('failed');
  });
});

describe('runCopySquad — loads PIR from DB when not provided', () => {
  it('fetches PIR via pirDocumentId when input.pir is omitted', async () => {
    const pir = makeValidPir();
    // DB mock that returns the PIR row.
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ content: pir }],
            orderBy: () => ({ limit: async () => [] }),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({ returning: async () => [{ id: 'deck-2' }] }),
      }),
    } as unknown as Database;

    const { client } = makeRoutedClaude({
      hormozi: HORMOZI_OK,
      schwartz: SCHWARTZ_OK,
      halbert: HALBERT_OK,
      cialdini: CIALDINI_OK,
      voss: VOSS_OK,
      chief: CHIEF_OK,
    });

    const result = await runCopySquad(
      { landingPageId: 'lp-1', pirDocumentId: 'pir-1', language: 'en' },
      { claude: client, db },
    );

    expect(result.copyDeckId).toBe('deck-2');
  });

  it('throws when PIR row not found in DB', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
            orderBy: () => ({ limit: async () => [] }),
          }),
        }),
      }),
      insert: () => ({ values: () => ({ returning: async () => [] }) }),
    } as unknown as Database;

    const { client } = makeRoutedClaude({
      hormozi: HORMOZI_OK,
      schwartz: SCHWARTZ_OK,
      halbert: HALBERT_OK,
      cialdini: CIALDINI_OK,
      voss: VOSS_OK,
      chief: CHIEF_OK,
    });

    await expect(
      runCopySquad(
        { landingPageId: 'lp-1', pirDocumentId: 'missing-pir', language: 'en' },
        { claude: client, db },
      ),
    ).rejects.toThrow(/PIR document not found/);
  });
});

describe('runCopySquad — language support', () => {
  it.each(['de', 'it', 'fr', 'es'] as const)('accepts language %s', async (lang) => {
    // Chief needs to return a deck with the correct language field.
    const { client } = makeRoutedClaude({
      hormozi: HORMOZI_OK,
      schwartz: SCHWARTZ_OK,
      halbert: HALBERT_OK,
      cialdini: CIALDINI_OK,
      voss: VOSS_OK,
      chief: () => JSON.stringify({ ...makeValidCopyDeck({ language: lang }), chief_notes: '' }),
    });

    const result = await runCopySquad(
      { landingPageId: 'lp-1', pirDocumentId: 'pir-1', pir: makeValidPir(), language: lang },
      { claude: client, db: makeMockDb() },
    );

    expect(result.language).toBe(lang);
    expect(result.copyDeck.language).toBe(lang);
  });
});

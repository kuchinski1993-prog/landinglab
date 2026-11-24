// Shared helpers for copywriter agents.
//
// Every copywriter follows the same flow:
//   1. Build system prompt (interpolates PIR)
//   2. Call Claude Opus
//   3. Parse JSON from response.content (retry once on parse failure)
//   4. Return CopyWorkerOutput with contributions + trace
//
// This module centralizes step 2-4. Each agent module supplies the prompt
// and a contribution mapper (raw JSON → typed CopyContributions).

import type { ClaudeTextClient } from '../providers/claude.js';
import type { CopyContributions, CopyTraceEntry, CopyWorkerOutput } from './types.js';

export interface RunClaudeAgentOptions {
  agentName: CopyWorkerOutput['agent'];
  systemPrompt: string;
  userMessage: string;
  claude: ClaudeTextClient;
  /** Maps parsed JSON to typed contributions. Return null to signal invalid shape. */
  mapContributions: (raw: unknown) => CopyContributions | null;
  /** Optional temperature override (default 0.7). */
  temperature?: number;
  /** Optional maxTokens override (default 4096). */
  maxTokens?: number;
}

/** Runs a copywriter with 1 retry on JSON parse failure. Never throws — returns failed output. */
export async function runClaudeAgent(opts: RunClaudeAgentOptions): Promise<CopyWorkerOutput> {
  const started = Date.now();
  let tokens_in = 0;
  let tokens_out = 0;
  let cost_usd = 0;
  let lastError = 'unknown_failure';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const systemForAttempt =
        attempt === 0
          ? opts.systemPrompt
          : `${opts.systemPrompt}\n\nPREVIOUS ATTEMPT DID NOT RETURN VALID JSON. Return a SINGLE JSON object matching the required shape. No prose. No markdown. No code fences.`;

      const res = await opts.claude.createMessage({
        system: systemForAttempt,
        messages: [{ role: 'user', content: opts.userMessage }],
        jsonMode: true,
        temperature: opts.temperature ?? (attempt === 0 ? 0.7 : 0.3),
        maxTokens: opts.maxTokens ?? 4096,
      });
      tokens_in += res.tokens_in;
      tokens_out += res.tokens_out;
      cost_usd += res.cost_usd;

      const parsed = tryParseJson(res.content);
      if (!parsed) {
        lastError = 'invalid_json_response';
        continue;
      }
      const contributions = opts.mapContributions(parsed);
      if (!contributions) {
        lastError = 'contribution_mapper_returned_null';
        continue;
      }

      const trace: CopyTraceEntry = {
        agent: opts.agentName,
        provider: 'anthropic',
        tokens_in,
        tokens_out,
        cost_usd,
        latency_ms: Date.now() - started,
        status: 'ok',
      };
      return { agent: opts.agentName, contributions, trace };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 1) break;
    }
  }

  return {
    agent: opts.agentName,
    contributions: {},
    trace: {
      agent: opts.agentName,
      provider: 'anthropic',
      tokens_in,
      tokens_out,
      cost_usd,
      latency_ms: Date.now() - started,
      status: 'failed',
      error: lastError,
    },
  };
}

/** Parses JSON, tolerating a stray code-fence wrapping. */
export function tryParseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    // Try to extract a top-level JSON object from prose.
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

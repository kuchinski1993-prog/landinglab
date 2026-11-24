// Claude Haiku 4.5 client — minimal provider for SEO Optimizer meta descriptions.
//
// Story 13.6, AC16.
//
// Why Haiku (not Opus like Squad 2): meta description generation is a
// short, low-stakes task. Haiku 4.5 costs ~$0.80/M input, $4/M output vs
// Opus 4.7 at $15/M input / $75/M output. Meta description = 20-50 tokens
// out, target cost ~$0.02/landing.
//
// Fallback contract: `generateMetaDescription()` returns `null` (never throws)
// when LANDINGLAB_ANTHROPIC_KEY is missing OR the API call fails. The
// seo-optimizer agent treats `null` as a signal to use the deterministic
// fallback (truncate copyDeck.subheads[0] to 160 chars).
//
// Wave 1 status: STUB. Wave 2 implements real HTTP via @anthropic-ai/sdk,
// mirroring packages/landinglab-copy/src/providers/claude.ts.

import Anthropic from '@anthropic-ai/sdk';

// Preços atualizados Haiku 4.5 (setembro/2026). Ajustar se rate card mudar.
const HAIKU_INPUT_COST_PER_TOKEN = 0.8 / 1_000_000;
const HAIKU_OUTPUT_COST_PER_TOKEN = 4 / 1_000_000;
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface HaikuMetaResult {
  content: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  cost_usd: number;
  model: string;
}

export interface ClaudeHaikuClient {
  /**
   * Returns generated meta description (max 160 chars, always trimmed).
   * Returns null when key missing or HTTP fails — caller uses deterministic fallback.
   * NEVER throws.
   */
  generateMetaDescription(prompt: string): Promise<HaikuMetaResult | null>;
}

/**
 * Wave 1: creates a stub that throws NotImplementedError on invocation.
 * Wave 2: real HTTP via @anthropic-ai/sdk (currently just the never-throwing
 *         wrapper so seo-optimizer's null-check contract is honored).
 *
 * @param opts.stub - When true, generateMetaDescription() throws NotImplementedError
 *                    (Wave 2 will remove this flag).
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export function createClaudeHaikuClient(opts?: { stub?: boolean }): ClaudeHaikuClient {
  if (opts?.stub === true) {
    return {
      async generateMetaDescription(): Promise<HaikuMetaResult | null> {
        throw new NotImplementedError(
          'createClaudeHaikuClient({ stub: true }): generateMetaDescription is a Wave 1 stub. ' +
            'Wave 2 implements real HTTP.',
        );
      },
    };
  }
  // Wave 2 real HTTP implementation (never-throwing to preserve null-fallback contract).
  return {
    async generateMetaDescription(prompt: string): Promise<HaikuMetaResult | null> {
      const apiKey = process.env['LANDINGLAB_ANTHROPIC_KEY'];
      if (!apiKey) return null;

      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const client = new Anthropic({ apiKey });
        const res = await client.messages.create(
          {
            model: DEFAULT_MODEL,
            max_tokens: 200,
            temperature: 0.7,
            system:
              'You write SEO meta descriptions. Respond with the description text ONLY — no quotes, no markdown, no prefix. Hard limit: 160 characters.',
            messages: [{ role: 'user', content: prompt }],
          },
          { signal: controller.signal },
        );
        const textBlock = res.content.find(
          (c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text',
        );
        const raw = textBlock?.text ?? '';
        // Hard trim to 160 — Zod schema also enforces, this is defense in depth.
        const content = raw.trim().slice(0, 160);
        if (content.length < 50) return null; // too short to be useful → fallback

        const tokens_in = res.usage?.input_tokens ?? 0;
        const tokens_out = res.usage?.output_tokens ?? 0;
        const cost_usd =
          tokens_in * HAIKU_INPUT_COST_PER_TOKEN + tokens_out * HAIKU_OUTPUT_COST_PER_TOKEN;
        return {
          content,
          tokens_in,
          tokens_out,
          latency_ms: Date.now() - started,
          cost_usd,
          model: DEFAULT_MODEL,
        };
      } catch {
        return null; // never throw — caller uses fallback
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

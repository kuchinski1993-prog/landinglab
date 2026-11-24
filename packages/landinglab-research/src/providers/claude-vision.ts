// Claude vision + text client — compartilhado por @vision-verifier (Vera) e
// @pir-synthesizer (Sage).
//
// SDK: @anthropic-ai/sdk (mesmo que packages/trustshield/src/ai/client.ts usa).
// Modelo default: 'claude-opus-4-7' (canonicalizado internamente pelo SDK).
//
// Custo: Claude Opus 4.7 ≈ $15/M input, $75/M output (dez/2026 rates).

import Anthropic from '@anthropic-ai/sdk';

import { ProviderConfigError, ProviderHttpError } from './errors.js';

// Preços atualizados Opus 4.7 (dez/2026). Ajustar se Anthropic mudar rate card.
const OPUS_INPUT_COST_PER_TOKEN = 15 / 1_000_000;
const OPUS_OUTPUT_COST_PER_TOKEN = 75 / 1_000_000;
const DEFAULT_MODEL = 'claude-opus-4-7';
const DEFAULT_TIMEOUT_MS = 90_000;

export type ClaudeModel =
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-7'
  | 'claude-haiku-4-7'
  | (string & {});

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string };
    };

export interface ClaudeMessagesOpts {
  model?: ClaudeModel;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: ClaudeContentBlock[] | string }>;
  temperature?: number;
  maxTokens?: number;
  /** Force JSON output — se true, injeta instrução no system prompt. */
  jsonMode?: boolean;
  timeoutMs?: number;
}

export interface ClaudeMessagesResult {
  content: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  cost_usd: number;
  model: ClaudeModel;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | (string & {});
}

export interface ClaudeVisionClient {
  createMessage(opts: ClaudeMessagesOpts): Promise<ClaudeMessagesResult>;
}

export function createClaudeVisionClient(): ClaudeVisionClient {
  return {
    async createMessage(opts: ClaudeMessagesOpts): Promise<ClaudeMessagesResult> {
      const apiKey = process.env['LANDINGLAB_ANTHROPIC_KEY'];
      if (!apiKey) {
        throw new ProviderConfigError('anthropic', 'LANDINGLAB_ANTHROPIC_KEY');
      }
      const model = opts.model ?? DEFAULT_MODEL;
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxTokens = opts.maxTokens ?? 4096;
      // Opus 4.7 deprecated `temperature` (API returns 400). Only forward the
      // param when caller explicitly sets it AND we're on a model that still
      // accepts it. Default: OMIT temperature.
      const supportsTemperature = !model.startsWith('claude-opus-4-7');
      const temperature =
        opts.temperature !== undefined && supportsTemperature ? opts.temperature : undefined;
      const systemFinal = opts.jsonMode
        ? `${opts.system}\n\nCRITICAL: Respond with a single JSON object only. No prose, no markdown, no code fences.`
        : opts.system;

      const client = new Anthropic({ apiKey });
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const createParams: Anthropic.MessageCreateParamsNonStreaming = {
          model,
          max_tokens: maxTokens,
          system: systemFinal,
          // SDK aceita `content` string OR array of blocks — passamos como está.
          messages: opts.messages as unknown as never,
        };
        if (temperature !== undefined) {
          createParams.temperature = temperature;
        }
        const res = await client.messages.create(createParams, { signal: controller.signal });
        const textBlock = res.content.find((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text');
        const content = textBlock?.text ?? '';
        const tokens_in = res.usage?.input_tokens ?? 0;
        const tokens_out = res.usage?.output_tokens ?? 0;
        const cost_usd =
          tokens_in * OPUS_INPUT_COST_PER_TOKEN + tokens_out * OPUS_OUTPUT_COST_PER_TOKEN;
        return {
          content,
          tokens_in,
          tokens_out,
          latency_ms: Date.now() - started,
          cost_usd,
          model,
          stop_reason: (res.stop_reason ?? 'end_turn') as ClaudeMessagesResult['stop_reason'],
        };
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (typeof status === 'number') {
          throw new ProviderHttpError('anthropic', status, (err as Error).message);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

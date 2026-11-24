// Claude text-only client — usado por todos os 6 copywriters do Squad 2.
//
// SDK: @anthropic-ai/sdk (mesmo que Squad 1 e trustshield usam).
// Modelo default: 'claude-opus-4-7'.
// Reusa env var LANDINGLAB_ANTHROPIC_KEY (Squad 1 já a exige — Story 13.3 AC18).
//
// Diferença vs Squad 1 claude-vision.ts: TEXT-ONLY (nenhum content block de imagem).
// Squad 2 recebe apenas PIR text + system prompts embutidos em TS.
//
// Custo: Claude Opus 4.7 ≈ $15/M input, $75/M output (rate card dez/2026).
//
// Wave 1 status: STUB. Implementação HTTP real vem na Wave 2.

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

export interface ClaudeTextMessagesOpts {
  model?: ClaudeModel;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  /** Force JSON output — injeta instrução no system prompt. */
  jsonMode?: boolean;
  timeoutMs?: number;
}

export interface ClaudeTextMessagesResult {
  content: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  cost_usd: number;
  model: ClaudeModel;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | (string & {});
}

export interface ClaudeTextClient {
  createMessage(opts: ClaudeTextMessagesOpts): Promise<ClaudeTextMessagesResult>;
}

/**
 * Cria um cliente Claude text-only para os 6 copywriters do Squad 2.
 * Reusa LANDINGLAB_ANTHROPIC_KEY (Squad 1).
 *
 * Wave 1: retorna client que lança NotImplementedError na invocação.
 * Wave 2: implementação HTTP real (padrão idêntico ao claude-vision.ts).
 */
export function createClaudeTextClient(opts?: { stub?: boolean }): ClaudeTextClient {
  // Wave 2 default: real HTTP. Tests inject their own mocked client via deps.
  if (opts?.stub === true) {
    return {
      async createMessage(): Promise<ClaudeTextMessagesResult> {
        return {
          content: '{"stub":true}',
          tokens_in: 0,
          tokens_out: 0,
          latency_ms: 0,
          cost_usd: 0,
          model: DEFAULT_MODEL,
          stop_reason: 'end_turn',
        };
      },
    };
  }
  // Wave 2 real implementation.
  return {
    async createMessage(
      messageOpts: ClaudeTextMessagesOpts,
    ): Promise<ClaudeTextMessagesResult> {
      const apiKey = process.env['LANDINGLAB_ANTHROPIC_KEY'];
      if (!apiKey) {
        throw new ProviderConfigError('anthropic', 'LANDINGLAB_ANTHROPIC_KEY');
      }
      const model = messageOpts.model ?? DEFAULT_MODEL;
      const timeoutMs = messageOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxTokens = messageOpts.maxTokens ?? 4096;
      // Opus 4.7 deprecated `temperature` (API returns 400). Only forward the
      // param when caller explicitly sets it AND we're on a model that still
      // accepts it. Default: OMIT temperature.
      const supportsTemperature = !model.startsWith('claude-opus-4-7');
      const temperature =
        messageOpts.temperature !== undefined && supportsTemperature
          ? messageOpts.temperature
          : undefined;
      const systemFinal = messageOpts.jsonMode
        ? `${messageOpts.system}\n\nCRITICAL: Respond with a single JSON object only. No prose, no markdown, no code fences.`
        : messageOpts.system;

      const client = new Anthropic({ apiKey });
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const createParams: Anthropic.MessageCreateParamsNonStreaming = {
          model,
          max_tokens: maxTokens,
          system: systemFinal,
          messages: messageOpts.messages,
        };
        if (temperature !== undefined) {
          createParams.temperature = temperature;
        }
        const res = await client.messages.create(createParams, { signal: controller.signal });
        const textBlock = res.content.find(
          (c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text',
        );
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
          stop_reason: (res.stop_reason ?? 'end_turn') as ClaudeTextMessagesResult['stop_reason'],
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

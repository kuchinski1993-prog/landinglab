// Gemini vision client — substituto barato do Claude Opus vision pra
// @vision-verifier (Vera) no Squad 1.
//
// Modelo: gemini-3.6-flash — ~$0.075/M input, $0.30/M output (Q3 2026).
// gemini-2.0-flash foi deprecado em 2026; substituto direto é 3.6-flash.
// Multiplica preço do Opus (~$15/M input) por ~200x mais barato — ideal pra
// verificar match de produto (task simples, alta frequência).
//
// Endpoint REST direto (sem SDK) pra não somar dependência.
// Docs: https://ai.google.dev/api/generate-content
//
// Interface intencionalmente compatível com ClaudeVisionClient — vision-verifier
// pode chavear entre providers sem tocar em business logic. Bloco `image` com
// `source.type='url'` é convertido pra `file_data` do Gemini (que aceita URL
// direto via `fileUri`).

import { ProviderConfigError, ProviderHttpError } from './errors.js';

// Preços Gemini 2.0 Flash (dez/2026). Ajustar se Google mudar.
const GEMINI_FLASH_INPUT_COST_PER_TOKEN = 0.075 / 1_000_000;
const GEMINI_FLASH_OUTPUT_COST_PER_TOKEN = 0.3 / 1_000_000;
const DEFAULT_MODEL = 'gemini-3.6-flash';
const DEFAULT_TIMEOUT_MS = 60_000;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export type GeminiModel =
  | 'gemini-3.6-flash'
  | 'gemini-3.6-flash-lite'
  | 'gemini-2.0-flash' // deprecado — mantido pra compat
  | 'gemini-1.5-flash'
  | 'gemini-1.5-pro'
  | (string & {});

// Shape idêntico ao ClaudeContentBlock pra manter interface uniforme.
export type GeminiContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string };
    };

export interface GeminiMessagesOpts {
  model?: GeminiModel;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: GeminiContentBlock[] | string }>;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
}

export interface GeminiMessagesResult {
  content: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  cost_usd: number;
  model: GeminiModel;
  stop_reason: string;
}

export interface GeminiVisionClient {
  createMessage(opts: GeminiMessagesOpts): Promise<GeminiMessagesResult>;
}

// Baixa a imagem por URL, converte para inlineData base64 — Gemini v1beta
// não aceita `fileUri` de URLs arbitrárias (só GCS/YouTube). Estratégia
// pragmática pra manter compatibilidade com o formato `source.type='url'`.
async function urlToInlineData(
  url: string,
  timeoutMs: number,
): Promise<{ mime_type: string; data: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      // UA "browser-like" — muitos CDNs (fbcdn, cdn.shopify) bloqueiam curl-like.
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        Accept: 'image/*',
      },
    });
    if (!res.ok) {
      throw new ProviderHttpError('gemini_image_fetch', res.status, `fetch ${url}`);
    }
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const mimeType = contentType.split(';')[0]!.trim();
    const buf = Buffer.from(await res.arrayBuffer());
    return { mime_type: mimeType, data: buf.toString('base64') };
  } finally {
    clearTimeout(timer);
  }
}

interface GeminiRestPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiRestContent {
  role: 'user' | 'model';
  parts: GeminiRestPart[];
}

interface GeminiRestRequest {
  contents: GeminiRestContent[];
  system_instruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: string;
  };
}

interface GeminiRestResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { code: number; message: string; status: string };
}

async function blocksToParts(
  blocks: GeminiContentBlock[] | string,
  imageFetchTimeoutMs: number,
): Promise<GeminiRestPart[]> {
  if (typeof blocks === 'string') return [{ text: blocks }];
  const parts: GeminiRestPart[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push({ text: b.text });
    } else if (b.type === 'image') {
      if (b.source.type === 'base64') {
        parts.push({
          inline_data: { mime_type: b.source.media_type, data: b.source.data },
        });
      } else {
        const inline = await urlToInlineData(b.source.url, imageFetchTimeoutMs);
        parts.push({ inline_data: inline });
      }
    }
  }
  return parts;
}

export function createGeminiVisionClient(): GeminiVisionClient {
  return {
    async createMessage(opts: GeminiMessagesOpts): Promise<GeminiMessagesResult> {
      const apiKey =
        process.env['LANDINGLAB_GEMINI_KEY'] ??
        process.env['GEMINI_API_KEY'] ??
        process.env['GOOGLE_API_KEY'];
      if (!apiKey) {
        throw new ProviderConfigError(
          'gemini',
          'LANDINGLAB_GEMINI_KEY (or GEMINI_API_KEY / GOOGLE_API_KEY)',
        );
      }
      const model = opts.model ?? DEFAULT_MODEL;
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // Budget image fetch em ~25% do timeout total (pode ter várias imgs).
      const imageFetchTimeoutMs = Math.max(10_000, Math.floor(timeoutMs / 4));

      // Concat todas as messages num único user turn (Gemini prefere um turn com
      // várias parts pra vision tasks; multi-turn não agrega valor aqui).
      const allParts: GeminiRestPart[] = [];
      for (const msg of opts.messages) {
        const parts = await blocksToParts(msg.content, imageFetchTimeoutMs);
        allParts.push(...parts);
      }

      const systemFinal = opts.jsonMode
        ? `${opts.system}\n\nCRITICAL: Return VALID JSON only. No prose, no markdown, no code fences.`
        : opts.system;

      const body: GeminiRestRequest = {
        contents: [{ role: 'user', parts: allParts }],
        system_instruction: { parts: [{ text: systemFinal }] },
        generationConfig: {
          maxOutputTokens: opts.maxTokens ?? 4096,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      };

      const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as GeminiRestResponse;
        if (!res.ok || json.error) {
          const msg = json.error?.message ?? `HTTP ${res.status}`;
          throw new ProviderHttpError('gemini', res.status, msg);
        }
        const candidate = json.candidates?.[0];
        const text = (candidate?.content?.parts ?? [])
          .map((p) => p.text ?? '')
          .join('');
        const tokens_in = json.usageMetadata?.promptTokenCount ?? 0;
        const tokens_out = json.usageMetadata?.candidatesTokenCount ?? 0;
        const cost_usd =
          tokens_in * GEMINI_FLASH_INPUT_COST_PER_TOKEN +
          tokens_out * GEMINI_FLASH_OUTPUT_COST_PER_TOKEN;
        return {
          content: text,
          tokens_in,
          tokens_out,
          latency_ms: Date.now() - started,
          cost_usd,
          model,
          stop_reason: candidate?.finishReason ?? 'STOP',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

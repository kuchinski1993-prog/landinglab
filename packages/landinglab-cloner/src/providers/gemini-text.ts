// Gemini text client — chamada REST leve pra Gemini 2.0 Flash.
//
// Usado pelo text-translator (Fase 5.B) pra traduzir batches de strings
// preservando formatação. Mesma abordagem da @blackshop/landinglab-research
// (gemini-vision.ts) mas sem imagens — só texto.
//
// Docs: https://ai.google.dev/api/generate-content

const GEMINI_FLASH_INPUT_COST_PER_TOKEN = 0.075 / 1_000_000;
const GEMINI_FLASH_OUTPUT_COST_PER_TOKEN = 0.3 / 1_000_000;
// gemini-3.6-flash é o modelo Flash atual (Q3 2026). Custo similar ao 2.0.
const DEFAULT_MODEL = 'gemini-3.6-flash';
const DEFAULT_TIMEOUT_MS = 60_000;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiTextOpts {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
}

export interface GeminiTextResult {
  content: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  model: string;
}

interface GeminiRestResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { code: number; message: string; status: string };
}

// Retry policy: retry em 429 (rate limit) e 503 (overloaded). Backoff exponencial
// com jitter. Max 3 tentativas totais. Erros 4xx (exceto 429) NÃO retentam.
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1500;

async function callGeminiOnce(
  opts: GeminiTextOpts,
  apiKey: string,
): Promise<GeminiTextResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const systemFinal = opts.jsonMode
    ? `${opts.system}\n\nCRITICAL: Return VALID JSON only. No prose, no markdown, no code fences.`
    : opts.system;

  const body = {
    contents: [{ role: 'user' as const, parts: [{ text: opts.user }] }],
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
      const err = new Error(
        `Gemini HTTP ${res.status}: ${json.error?.message ?? 'unknown error'}`,
      ) as Error & { httpStatus?: number };
      err.httpStatus = res.status;
      throw err;
    }
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const tokens_in = json.usageMetadata?.promptTokenCount ?? 0;
    const tokens_out = json.usageMetadata?.candidatesTokenCount ?? 0;
    const cost_usd =
      tokens_in * GEMINI_FLASH_INPUT_COST_PER_TOKEN +
      tokens_out * GEMINI_FLASH_OUTPUT_COST_PER_TOKEN;
    return {
      content: text,
      tokens_in,
      tokens_out,
      cost_usd,
      latency_ms: Date.now() - started,
      model,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function callGemini(opts: GeminiTextOpts): Promise<GeminiTextResult> {
  const apiKey =
    process.env['LANDINGLAB_GEMINI_KEY'] ??
    process.env['GEMINI_API_KEY'] ??
    process.env['GOOGLE_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'Gemini API key ausente. Set LANDINGLAB_GEMINI_KEY (ou GEMINI_API_KEY / GOOGLE_API_KEY).',
    );
  }

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await callGeminiOnce(opts, apiKey);
    } catch (err) {
      lastErr = err as Error;
      const status = (err as Error & { httpStatus?: number }).httpStatus;
      // Retry APENAS em rate-limit (429) e overloaded (503). 400/401/404 param.
      if (status !== 429 && status !== 503) throw err;
      if (attempt === MAX_RETRIES - 1) throw err;
      const delay = RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error('Gemini retry exhausted');
}

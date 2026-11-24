// Gemini Vision provider — chamadas com input imagem inline (base64).
//
// Usa mesma API REST de Gemini text (`generativelanguage.googleapis.com/v1beta`)
// mas o body inclui `inline_data` com bytes da imagem em base64.
//
// Uso pelo image-relevance-classifier — classifica cada imagem como
// relevante/irrelevante pra rebrand.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.6-flash';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1500;

// Preços (out/2026, ajustar quando rate card mudar):
const GEMINI_VISION_INPUT_COST_PER_TOKEN = 0.075 / 1_000_000;
const GEMINI_VISION_OUTPUT_COST_PER_TOKEN = 0.3 / 1_000_000;

export interface GeminiVisionOpts {
  system: string;
  user: string;
  /** Imagem em base64 (sem prefixo data: URL). */
  imageBase64: string;
  /** MIME type da imagem (image/jpeg, image/png, etc). */
  imageMimeType: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface GeminiVisionResult {
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

async function callVisionOnce(
  opts: GeminiVisionOpts,
  apiKey: string,
): Promise<GeminiVisionResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body = {
    contents: [
      {
        role: 'user' as const,
        parts: [
          {
            inline_data: {
              mime_type: opts.imageMimeType,
              data: opts.imageBase64,
            },
          },
          { text: opts.user },
        ],
      },
    ],
    system_instruction: { parts: [{ text: opts.system }] },
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 500,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      responseMimeType: 'application/json',
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
        `Gemini Vision HTTP ${res.status}: ${json.error?.message ?? 'unknown error'}`,
      ) as Error & { httpStatus?: number };
      err.httpStatus = res.status;
      throw err;
    }
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const tokens_in = json.usageMetadata?.promptTokenCount ?? 0;
    const tokens_out = json.usageMetadata?.candidatesTokenCount ?? 0;
    const cost_usd =
      tokens_in * GEMINI_VISION_INPUT_COST_PER_TOKEN +
      tokens_out * GEMINI_VISION_OUTPUT_COST_PER_TOKEN;
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

export async function callGeminiVision(
  opts: GeminiVisionOpts,
): Promise<GeminiVisionResult> {
  // Fase S.2.3 — Guard: Vision desativado por default (roda em 200-300 imagens
  // por landing = $0.28 por reclone). Usuário decidiu que Gemini deve ser
  // usado APENAS pra tradução de texto. Opt-in via USE_GEMINI_VISION_CLASSIFIER=1.
  if (process.env['USE_GEMINI_VISION_CLASSIFIER'] !== '1') {
    throw new Error(
      'Gemini Vision desativado. Uso reservado pra tradução de texto. ' +
      'Set USE_GEMINI_VISION_CLASSIFIER=1 pra opt-in.',
    );
  }

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
      return await callVisionOnce(opts, apiKey);
    } catch (err) {
      lastErr = err as Error;
      const status = (err as Error & { httpStatus?: number }).httpStatus;
      if (status !== 429 && status !== 503) throw err;
      if (attempt === MAX_RETRIES - 1) throw err;
      const delay = RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error('Gemini Vision retry exhausted');
}

// Google Gemini 2.5 Flash Image (aka "Nano Banana") client — image editing
// endpoint. Recebe imagem base + prompt e retorna imagem editada.
//
// Diferença vs Seedream: consenso da comunidade coloca Nano Banana como
// SOTA em text-in-image editing preserving. Especificamente melhor pra
// manter nomes de produto/marca (CAYENNE MAX, BePurex) sem "escorregar"
// em traduções/transliterações que Seedream faz.
//
// Modelo: gemini-2.5-flash-image-preview
// Preço out/2026: ~$0.039 por imagem gerada (comparável ao Seedream).
// Latência típica: 3-8s (sync, sem polling — muito mais rápido que Seedream).

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface GeminiImageEditInput {
  /** URL pública da imagem original (baixamos e passamos como inline_data). */
  imageUrl: string;
  /** Prompt de edição — instrução guiada pra o modelo. */
  prompt: string;
}

export interface GeminiImageEditResult {
  imageBuffer: Buffer | null;
  mimeType: string;
  status: 'COMPLETED' | 'FAILED';
  latencyMs: number;
  costUsd: number;
  error?: string;
}

/**
 * Baixa a imagem original, envia inline_data pro Gemini com prompt, recebe
 * de volta a imagem editada como base64. Sem polling — response contém
 * imagem direto.
 */
export async function editImageWithNanoBanana(
  input: GeminiImageEditInput,
): Promise<GeminiImageEditResult> {
  // Fase S.2.3 — Guard: por default, Nano Banana está DESLIGADO.
  // Usuário decidiu que Gemini deve ser usado APENAS pra tradução de texto,
  // não pra editar imagens (Freepik Seedream é o provider oficial de image
  // edit). Opt-in via USE_NANO_BANANA=1 pra experimentação.
  if (process.env['USE_NANO_BANANA'] !== '1') {
    return {
      imageBuffer: null,
      mimeType: '',
      status: 'FAILED',
      latencyMs: 0,
      costUsd: 0,
      error:
        'Nano Banana desativado. Gemini reservado pra tradução de texto. ' +
        'Use Freepik Seedream pra image edit (USE_SEEDREAM_FALLBACK=1 já é default).',
    };
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

  const started = Date.now();

  // 1. Baixa imagem original pra inline_data (Gemini precisa base64)
  let imageBase64: string;
  let sourceMime: string;
  try {
    const res = await fetch(input.imageUrl);
    if (!res.ok) {
      throw new Error(`Falha ao baixar imagem original HTTP ${res.status}`);
    }
    sourceMime = res.headers.get('content-type') ?? 'image/webp';
    // Normaliza: Gemini aceita image/png, image/jpeg, image/webp
    if (!/^image\//i.test(sourceMime)) sourceMime = 'image/webp';
    const buf = Buffer.from(await res.arrayBuffer());
    imageBase64 = buf.toString('base64');
  } catch (err) {
    return {
      imageBuffer: null,
      mimeType: '',
      status: 'FAILED',
      latencyMs: Date.now() - started,
      costUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. Chama Gemini image edit endpoint
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const url =
      `${GEMINI_API_BASE}/models/gemini-2.5-flash-image-preview:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: input.prompt },
            {
              inline_data: {
                mime_type: sourceMime,
                data: imageBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        // Sem essa flag, modelo pode responder texto em vez de imagem
        responseModalities: ['IMAGE'],
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inline_data?: { mime_type: string; data: string };
            text?: string;
          }>;
        };
        finishReason?: string;
      }>;
      error?: { message?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    if (!res.ok || json.error) {
      return {
        imageBuffer: null,
        mimeType: '',
        status: 'FAILED',
        latencyMs: Date.now() - started,
        costUsd: 0,
        error: `Gemini HTTP ${res.status}: ${json.error?.message ?? 'unknown'}`,
      };
    }

    // Encontra a parte que tem inline_data (imagem gerada)
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inline_data);

    if (!imagePart?.inline_data) {
      const textPart = parts.find((p) => p.text)?.text ?? 'no image in response';
      return {
        imageBuffer: null,
        mimeType: '',
        status: 'FAILED',
        latencyMs: Date.now() - started,
        costUsd: 0,
        error: `Sem imagem no response: ${textPart.slice(0, 200)}`,
      };
    }

    const outMime = imagePart.inline_data.mime_type;
    const outBuf = Buffer.from(imagePart.inline_data.data, 'base64');

    // Custo aproximado: $0.039 por imagem output (Gemini 2.5 Flash Image)
    // Ref: https://ai.google.dev/gemini-api/docs/pricing
    return {
      imageBuffer: outBuf,
      mimeType: outMime,
      status: 'COMPLETED',
      latencyMs: Date.now() - started,
      costUsd: 0.039,
    };
  } catch (err) {
    return {
      imageBuffer: null,
      mimeType: '',
      status: 'FAILED',
      latencyMs: Date.now() - started,
      costUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

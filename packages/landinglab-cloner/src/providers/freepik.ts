// Freepik / Magnific API client — Seedream 4.5 Edit endpoint.
//
// Endpoint assíncrono: POST retorna task_id → GET periódico → status COMPLETED
// devolve URL da imagem gerada. Pricing (out 2026): ~$0.03-0.04 por imagem.
//
// Uso pelo image-translator (Fase 5.C) pra traduzir texto embutido em imagens
// preservando layout/fonte/cores originais. Modelo bom pra texto legível.
//
// Nota: Freepik rebrandou pra Magnific em abr/2026. api.freepik.com ainda
// funciona (mantido por compat). Header x-freepik-api-key tbm.

const FREEPIK_API_BASE = 'https://api.freepik.com/v1';
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_ATTEMPTS = 40; // 40 × 3s = 120s max wait

export interface SeedreamEditInput {
  /** URL pública da imagem original (Seedream faz fetch). */
  imageUrl: string;
  /** Prompt de edição — instrução guiada pra o modelo. */
  prompt: string;
  /** Ratio (default square_1_1). */
  aspectRatio?: 'square_1_1' | 'landscape_16_9' | 'portrait_9_16' | 'landscape_4_3';
  /** Seed opcional pra reprodutibilidade. */
  seed?: number;
}

export interface SeedreamEditResult {
  taskId: string;
  imageUrl: string; // URL da imagem gerada (só válida após COMPLETED)
  status: 'COMPLETED' | 'FAILED' | 'TIMEOUT';
  latencyMs: number;
  costUsd: number;
  error?: string;
}

interface CreateTaskResponse {
  data?: {
    task_id: string;
    status: string;
    generated?: string[];
  };
  error?: string;
  message?: string;
}

interface GetTaskResponse {
  data?: {
    task_id: string;
    status: 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
    generated?: string[];
    error?: string;
  };
  error?: string;
  message?: string;
}

/**
 * Chama o endpoint Seedream 4.5 Edit e aguarda o resultado (polling).
 * Retorna URL da imagem editada + status.
 *
 * Custo estimado: $0.04/imagem (Freepik plano dev, out 2026).
 * Latência típica: 15-45s dependendo da fila Freepik.
 */
export async function editImageWithSeedream(
  input: SeedreamEditInput,
): Promise<SeedreamEditResult> {
  const apiKey = process.env['LANDINGLAB_FREEPIK_KEY'] ?? process.env['FREEPIK_API_KEY'];
  if (!apiKey) {
    throw new Error('LANDINGLAB_FREEPIK_KEY ausente no env.');
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  // ─── 1. POST create task ────────────────────────────────────────
  let taskId: string;
  try {
    const res = await fetch(
      `${FREEPIK_API_BASE}/ai/text-to-image/seedream-v4-5-edit`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-freepik-api-key': apiKey,
        },
        body: JSON.stringify({
          prompt: input.prompt,
          reference_images: [input.imageUrl],
          aspect_ratio: input.aspectRatio ?? 'square_1_1',
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
          enable_safety_checker: true,
        }),
      },
    );
    clearTimeout(timer);

    const json = (await res.json()) as CreateTaskResponse;
    if (!res.ok || json.error || !json.data?.task_id) {
      throw new Error(
        `Seedream create failed HTTP ${res.status}: ${json.error ?? json.message ?? 'unknown'}`,
      );
    }
    taskId = json.data.task_id;
  } catch (err) {
    clearTimeout(timer);
    return {
      taskId: '',
      imageUrl: '',
      status: 'FAILED',
      latencyMs: Date.now() - started,
      costUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // ─── 2. Poll GET status ─────────────────────────────────────────
  let attempts = 0;
  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const res = await fetch(
        `${FREEPIK_API_BASE}/ai/text-to-image/seedream-v4-5-edit/${encodeURIComponent(taskId)}`,
        {
          method: 'GET',
          headers: { 'x-freepik-api-key': apiKey },
        },
      );
      const json = (await res.json()) as GetTaskResponse;
      if (!res.ok || json.error) {
        // Erro transitório? tenta de novo até acabar attempts.
        continue;
      }
      const status = json.data?.status;
      if (status === 'COMPLETED') {
        const url = json.data?.generated?.[0];
        if (!url) {
          return {
            taskId,
            imageUrl: '',
            status: 'FAILED',
            latencyMs: Date.now() - started,
            costUsd: 0.04,
            error: 'COMPLETED sem URL de imagem no response',
          };
        }
        return {
          taskId,
          imageUrl: url,
          status: 'COMPLETED',
          latencyMs: Date.now() - started,
          costUsd: 0.04,
        };
      }
      if (status === 'FAILED') {
        return {
          taskId,
          imageUrl: '',
          status: 'FAILED',
          latencyMs: Date.now() - started,
          costUsd: 0.04,
          error: json.data?.error ?? 'Seedream retornou status FAILED',
        };
      }
      // CREATED ou IN_PROGRESS → continua polling.
    } catch {
      // network glitch — continua polling
    }
  }

  return {
    taskId,
    imageUrl: '',
    status: 'TIMEOUT',
    latencyMs: Date.now() - started,
    costUsd: 0.04, // presume cobrança mesmo com timeout (task foi criada)
    error: `Polling timeout após ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`,
  };
}

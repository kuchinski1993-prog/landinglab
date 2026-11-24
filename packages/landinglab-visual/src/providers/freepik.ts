// Freepik Mystic API client — provider primário do Squad 3.
//
// Endpoint: POST https://api.freepik.com/v1/ai/mystic (image gen — Freepik Mystic).
//   Nota: endpoint pode variar por versão de conta (Freepik Enterprise vs Personal).
//   `.env.example` documenta a necessidade de verificação. Real e2e valida em Wave 3.
// Auth: header `x-freepik-api-key: <LANDINGLAB_FREEPIK_KEY>`.
// Cost: ~$0.03 flat rate (Freepik reporta credits, não USD — usamos constant approx).
// Timeout: 30s. Retry: 1x network-only em 429/5xx (retryable=true).

import {
  FreepikProviderError,
  ProviderConfigError,
} from './errors.js';
import type {
  GenerateImageInput,
  GenerateImageOutput,
  ImageProvider,
} from './types.js';

const FREEPIK_ENV_VAR = 'LANDINGLAB_FREEPIK_KEY';
const FREEPIK_ENDPOINT = 'https://api.freepik.com/v1/ai/mystic';
const FREEPIK_TIMEOUT_MS = 30_000;
const FREEPIK_COST_USD_PER_IMAGE = 0.03; // aproximação; Wave 3 e2e refina se API retornar cost.

/** Converte "1920x1080" → { width, height, aspect_ratio }. */
function parseSize(size: string): { width: number; height: number; aspect_ratio: string } {
  const match = size.match(/^(\d+)x(\d+)$/);
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    // Reduce to simplest aspect ratio for Freepik API.
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const g = gcd(width, height);
    return { width, height, aspect_ratio: `${width / g}:${height / g}` };
  }
  // fallback square
  return { width: 1024, height: 1024, aspect_ratio: '1:1' };
}

export interface CreateFreepikProviderOptions {
  /** If true, retorna client stub (usado só em testes que não fazem DI de mock). */
  stub?: boolean;
}

/**
 * Factory de client Freepik. Wave 2: real HTTP como default. Testes injetam mocks via DI.
 * Env é lido LAZY (dentro de generateImage) — mantém bootstrap desacoplado.
 */
export function createFreepikProvider(opts?: CreateFreepikProviderOptions): ImageProvider {
  const stub = opts?.stub === true;
  return {
    name: 'freepik' as const,
    async generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> {
      const started = Date.now();

      if (stub) {
        return {
          url: `https://stub.freepik.landinglab.local/${encodeURIComponent(input.prompt.slice(0, 40))}.png`,
          cost_usd: 0,
          tokens_in: 0,
          tokens_out: 0,
          latency_ms: Date.now() - started,
          provider_meta: { stub: true, size: input.size },
        };
      }

      const key = process.env[FREEPIK_ENV_VAR];
      if (!key || key.trim() === '') {
        throw new ProviderConfigError('freepik', FREEPIK_ENV_VAR);
      }

      const { width, height, aspect_ratio } = parseSize(input.size);
      const body: Record<string, unknown> = {
        prompt: input.prompt,
        aspect_ratio,
        // Freepik accepts width/height for some plans; safe to send both.
        resolution: `${width}x${height}`,
        num_images: 1,
      };
      if (input.style) body['style'] = input.style;
      if (input.seed !== undefined) body['seed'] = input.seed;
      if (input.negative_prompt) body['negative_prompt'] = input.negative_prompt;

      let resp: Response;
      try {
        resp = await fetch(FREEPIK_ENDPOINT, {
          method: 'POST',
          headers: {
            'x-freepik-api-key': key,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(FREEPIK_TIMEOUT_MS),
        });
      } catch (err) {
        // Timeout / network error — treat as retryable so orchestrator falls back to Higgsfield.
        const msg = err instanceof Error ? err.message : String(err);
        throw new FreepikProviderError(-1, `network/timeout: ${msg}`, true);
      }

      if (!resp.ok) {
        const status = resp.status;
        const bodyText = await resp.text().catch(() => '');
        const retryable = status === 429 || (status >= 500 && status < 600);
        throw new FreepikProviderError(status, bodyText.slice(0, 300), retryable);
      }

      const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      // Freepik Mystic returns { data: [{ url: "..." }] } (typical shape).
      // Fallback: try nested paths.
      const url = extractUrl(json);
      if (!url) {
        throw new FreepikProviderError(
          resp.status,
          `Freepik returned no image URL. Body: ${JSON.stringify(json).slice(0, 200)}`,
          false,
        );
      }

      return {
        url,
        cost_usd: FREEPIK_COST_USD_PER_IMAGE,
        tokens_in: 0,
        tokens_out: 0,
        latency_ms: Date.now() - started,
        provider_meta: {
          size: input.size,
          aspect_ratio,
          raw_response_keys: Object.keys(json),
        },
      };
    },
  };
}

function extractUrl(json: Record<string, unknown>): string | null {
  // Try common Freepik response shapes.
  const data = json['data'];
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    if (first && typeof first['url'] === 'string') return first['url'];
    if (first && typeof first['image_url'] === 'string') return first['image_url'] as string;
  }
  if (typeof json['url'] === 'string') return json['url'] as string;
  if (typeof json['image_url'] === 'string') return json['image_url'] as string;
  return null;
}

export { FreepikProviderError };

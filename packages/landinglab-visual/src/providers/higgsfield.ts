// Higgsfield API client — provider fallback do Squad 3.
//
// [AUTO-DECISION Wave 2] Estratégia v1: Higgsfield real API endpoint não está
// publicamente documentado no momento da implementação. Wave 2 usa abordagem
// híbrida:
//   1. Se LANDINGLAB_HIGGSFIELD_KEY presente e envvar LANDINGLAB_HIGGSFIELD_ENDPOINT
//      apontar pra URL válida → tenta POST direto (best-guess payload).
//   2. Caso contrário → retorna placeholder URL (`https://placeholder.higgsfield...`)
//      com cost 0. Orchestrator loga o uso do placeholder em director_notes.
// Real API validation vai acontecer na Wave 3 (integration testing) — se skill
// path for necessário, migração é 1 arquivo (este).

import {
  HiggsFieldProviderError,
  ProviderConfigError,
} from './errors.js';
import type {
  GenerateImageInput,
  GenerateImageOutput,
  ImageProvider,
} from './types.js';

const HIGGSFIELD_ENV_VAR = 'LANDINGLAB_HIGGSFIELD_KEY';
const HIGGSFIELD_ENDPOINT_ENV = 'LANDINGLAB_HIGGSFIELD_ENDPOINT';
const HIGGSFIELD_TIMEOUT_MS = 45_000;
const HIGGSFIELD_COST_USD_PER_IMAGE = 0.05; // aproximação; higgsfield tende a ser mais caro que freepik.

export interface CreateHiggsfieldProviderOptions {
  /** If true, retorna placeholder puro (usado por testes sem DI de mock). */
  stub?: boolean;
  /**
   * If true (default false), força o placeholder mode mesmo com key presente.
   * Útil pra desenvolvimento local sem consumir quota.
   */
  forcePlaceholder?: boolean;
}

/**
 * Factory de client Higgsfield. Wave 2 default: real HTTP (com placeholder
 * fallback quando endpoint não configurado). Testes injetam mocks via DI.
 */
export function createHiggsfieldProvider(opts?: CreateHiggsfieldProviderOptions): ImageProvider {
  const stub = opts?.stub === true;
  const forcePlaceholder = opts?.forcePlaceholder === true;
  return {
    name: 'higgsfield' as const,
    async generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> {
      const started = Date.now();
      const slug = encodeURIComponent(input.prompt.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '-'));

      if (stub) {
        return {
          url: `https://stub.higgsfield.landinglab.local/${slug}.png`,
          cost_usd: 0,
          tokens_in: 0,
          tokens_out: 0,
          latency_ms: Date.now() - started,
          provider_meta: { stub: true, size: input.size },
        };
      }

      const key = process.env[HIGGSFIELD_ENV_VAR];
      const endpoint = process.env[HIGGSFIELD_ENDPOINT_ENV];

      // Placeholder path: sem key OU sem endpoint OU forçado.
      // Retorna URL de placeholder + cost 0. Orchestrator loga em director_notes.
      if (forcePlaceholder || !key || !endpoint) {
        return {
          url: `https://placeholder.higgsfield.landinglab.local/${slug}.png`,
          cost_usd: 0,
          tokens_in: 0,
          tokens_out: 0,
          latency_ms: Date.now() - started,
          provider_meta: {
            placeholder: true,
            reason: forcePlaceholder
              ? 'forcePlaceholder=true'
              : !key
                ? `missing_env:${HIGGSFIELD_ENV_VAR}`
                : `missing_env:${HIGGSFIELD_ENDPOINT_ENV}`,
            size: input.size,
          },
        };
      }

      // Real HTTP path.
      if (!key || key.trim() === '') {
        throw new ProviderConfigError('higgsfield', HIGGSFIELD_ENV_VAR);
      }

      const body: Record<string, unknown> = {
        prompt: input.prompt,
        size: input.size,
        num_images: 1,
      };
      if (input.style) body['style'] = input.style;
      if (input.seed !== undefined) body['seed'] = input.seed;
      if (input.negative_prompt) body['negative_prompt'] = input.negative_prompt;

      let resp: Response;
      try {
        resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(HIGGSFIELD_TIMEOUT_MS),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new HiggsFieldProviderError(-1, `network/timeout: ${msg}`);
      }

      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => '');
        throw new HiggsFieldProviderError(resp.status, bodyText.slice(0, 300));
      }

      const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      const url = extractUrl(json);
      if (!url) {
        throw new HiggsFieldProviderError(
          resp.status,
          `Higgsfield returned no image URL. Body: ${JSON.stringify(json).slice(0, 200)}`,
        );
      }

      return {
        url,
        cost_usd: HIGGSFIELD_COST_USD_PER_IMAGE,
        tokens_in: 0,
        tokens_out: 0,
        latency_ms: Date.now() - started,
        provider_meta: {
          size: input.size,
          raw_response_keys: Object.keys(json),
        },
      };
    },
  };
}

function extractUrl(json: Record<string, unknown>): string | null {
  const data = json['data'];
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    if (first && typeof first['url'] === 'string') return first['url'];
  }
  if (typeof json['url'] === 'string') return json['url'] as string;
  if (typeof json['image_url'] === 'string') return json['image_url'] as string;
  return null;
}

export { HiggsFieldProviderError };

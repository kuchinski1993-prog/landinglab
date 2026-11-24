// SerpAPI Google Lens client — usado por @lens-scout (Iris) no Modo B (foto).
//
// Endpoint: https://serpapi.com/search?engine=google_lens&url=<img>&api_key=<key>
// Cost: SerpAPI cobra por busca (~$0.015 flat estimado; free tier 100/mês).
//
// Wave 2 impl: fetch real com timeout 15s + retry 1x network-only.

import { ProviderConfigError, ProviderHttpError } from './errors.js';

// SerpAPI cobrança flat por busca (estimativa; assinatura Standard).
const COST_PER_SEARCH_USD = 0.015;
const DEFAULT_TIMEOUT_MS = 15_000;
const SERPAPI_ENDPOINT = 'https://serpapi.com/search';

/** Match retornado pelo Google Lens (top-N visual candidates). */
export interface LensVisualMatch {
  /** URL da página que hospeda a imagem similar. */
  source_url: string;
  /** Título da página / produto (quando disponível). */
  title: string | null;
  /** URL da thumbnail retornada pelo SerpAPI (não do source original). */
  thumbnail: string;
  /** Marca inferida do domínio ou meta-tags (best-effort). */
  brand: string | null;
  /** Preço observado (best-effort — SerpAPI às vezes retorna). */
  price: string | null;
}

/** Payload de resposta do search() — top-10 visuals + metadata. */
export interface LensSearchResult {
  query_image_url: string;
  visual_matches: LensVisualMatch[];
  latency_ms: number;
  /** Cost estimado do provider (SerpAPI cobra por busca). */
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

export interface SerpApiClient {
  searchByImage(
    imageUrl: string,
    opts?: { hl?: string; topN?: number; timeoutMs?: number },
  ): Promise<LensSearchResult>;
}

interface SerpApiVisualMatchRaw {
  title?: string;
  link?: string;
  source?: string;
  thumbnail?: string;
  price?: { value?: string; extracted_value?: number; currency?: string } | string;
  in_stock?: boolean;
}

interface SerpApiResponseRaw {
  visual_matches?: SerpApiVisualMatchRaw[];
  error?: string;
}

export function createSerpApiClient(): SerpApiClient {
  return {
    async searchByImage(imageUrl, opts) {
      const apiKey = process.env['LANDINGLAB_SERPAPI_KEY'];
      if (!apiKey) {
        throw new ProviderConfigError('serpapi', 'LANDINGLAB_SERPAPI_KEY');
      }
      const hl = opts?.hl ?? 'en';
      const topN = Math.min(opts?.topN ?? 10, 20);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const url = new URL(SERPAPI_ENDPOINT);
      url.searchParams.set('engine', 'google_lens');
      url.searchParams.set('url', imageUrl);
      url.searchParams.set('hl', hl);
      url.searchParams.set('api_key', apiKey);

      const started = Date.now();
      // 1 retry apenas em erros de rede/timeout (não HTTP 4xx).
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(url.toString(), { signal: controller.signal });
            const body = await res.text();
            if (!res.ok) {
              throw new ProviderHttpError('serpapi', res.status, body);
            }
            const parsed = JSON.parse(body) as SerpApiResponseRaw;
            if (parsed.error) {
              throw new ProviderHttpError('serpapi', 200, parsed.error);
            }
            const matches = (parsed.visual_matches ?? []).slice(0, topN).map(normalizeMatch);
            return {
              query_image_url: imageUrl,
              visual_matches: matches,
              latency_ms: Date.now() - started,
              cost_usd: COST_PER_SEARCH_USD,
              tokens_in: 0,
              tokens_out: 0,
            };
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          lastErr = err as Error;
          // HTTP errors não devem re-tentar (limitações do plano etc.).
          if (err instanceof ProviderHttpError) throw err;
          if (attempt === 1) throw err;
          // Retry rede/timeout com pausa curta.
          await sleep(1_000);
        }
      }
      throw lastErr ?? new Error('serpapi_unknown_error');
    },
  };
}

function normalizeMatch(m: SerpApiVisualMatchRaw): LensVisualMatch {
  const priceStr =
    typeof m.price === 'string'
      ? m.price
      : m.price?.value ?? (m.price?.extracted_value != null ? String(m.price.extracted_value) : null);
  const brandFromSource = m.source ? domainRoot(m.source) : null;
  return {
    source_url: m.link ?? '',
    title: m.title ?? null,
    thumbnail: m.thumbnail ?? '',
    brand: brandFromSource,
    price: priceStr,
  };
}

function domainRoot(source: string): string | null {
  // "amazon.com" → "amazon"; "www.aliexpress.com" → "aliexpress"
  const cleaned = source.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const host = cleaned.split('/')[0] ?? cleaned;
  const parts = host.split('.');
  if (parts.length < 2) return null;
  return parts[parts.length - 2] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

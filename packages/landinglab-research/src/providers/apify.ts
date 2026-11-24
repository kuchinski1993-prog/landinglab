// Apify Actor client — usado por @review-miner (Rita) pra scraping de reviews.
//
// Endpoint: POST https://api.apify.com/v2/acts/<actorId>/run-sync-get-dataset-items?token=<token>
// Actors suportados:
//   - epctex~amazon-reviews-scraper
//   - apify~trustpilot-reviews-scraper
//   - apify~reddit-scraper
// Cost: ~$0.03-0.08 flat estimado por Actor run (usa compute-units).

import { ProviderConfigError, ProviderHttpError } from './errors.js';

// Custo estimado por Actor run. Actor IDs usam '~' na URL (não '/').
const COST_PER_RUN_USD = 0.05;
const DEFAULT_TIMEOUT_MS = 120_000;
const APIFY_ENDPOINT_TPL = 'https://api.apify.com/v2/acts/{actorId}/run-sync-get-dataset-items';

/** Actor IDs suportados por Wave 2. */
export type ApifyActorId =
  | 'epctex/amazon-reviews-scraper'
  | 'apify/trustpilot-reviews-scraper'
  | 'apify/reddit-scraper-lite'
  | 'apify/reddit-scraper'
  | (string & {});

export interface ApifyRunOpts {
  actorId: ApifyActorId;
  input: Record<string, unknown>;
  timeoutSecs?: number;
  memoryMb?: number;
}

export interface ApifyRunResult<T = unknown> {
  actor_id: string;
  run_id: string;
  status: 'SUCCEEDED' | 'FAILED' | 'TIMED-OUT' | 'ABORTED';
  items: T[];
  latency_ms: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

export interface ApifyClient {
  runActor<T = unknown>(opts: ApifyRunOpts): Promise<ApifyRunResult<T>>;
}

export function createApifyClient(): ApifyClient {
  return {
    async runActor<T = unknown>(opts: ApifyRunOpts): Promise<ApifyRunResult<T>> {
      const token = process.env['LANDINGLAB_APIFY_TOKEN'];
      if (!token) {
        throw new ProviderConfigError('apify', 'LANDINGLAB_APIFY_TOKEN');
      }
      const timeoutSecs = opts.timeoutSecs ?? Math.floor(DEFAULT_TIMEOUT_MS / 1000);
      const timeoutMs = timeoutSecs * 1000 + 5_000; // margem de segurança sobre o timeout server-side
      const memoryMb = opts.memoryMb ?? 1024;
      const actorSlug = opts.actorId.replace('/', '~');
      const url = new URL(APIFY_ENDPOINT_TPL.replace('{actorId}', actorSlug));
      url.searchParams.set('token', token);
      url.searchParams.set('timeout', String(timeoutSecs));
      url.searchParams.set('memory', String(memoryMb));

      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts.input),
          signal: controller.signal,
        });
        const body = await res.text();
        if (!res.ok) {
          throw new ProviderHttpError('apify', res.status, body);
        }
        // run-sync-get-dataset-items retorna diretamente o array de items.
        const items = JSON.parse(body) as T[];
        return {
          actor_id: opts.actorId,
          run_id: `sync-${Date.now()}`,
          status: 'SUCCEEDED',
          items: Array.isArray(items) ? items : [],
          latency_ms: Date.now() - started,
          cost_usd: COST_PER_RUN_USD,
          tokens_in: 0,
          tokens_out: 0,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// Spaceship provider — Squad 5 (Deploy) — Wave 2 real HTTP.
//
// [AUTO-DECISION Wave 2] The existing @blackshop/landinglab-domains package
// only exposes the SpaceshipAdapter interface — no HTTP client existed there.
// Rather than round-trip the client through a second package, this file now
// hosts the minimal real implementation used by the Deploy Squad. Env vars
// are read lazily (worker bootstrap never blocks). Failures surface as
// ProviderRetryableError (HTTP 5xx / 429 / network) or ProviderConfigError
// (missing API key), keeping the taxonomy consistent with claude-haiku.

import type { SpaceshipAdapter, DnsRecord } from '@blackshop/landinglab-domains';

import { ProviderConfigError, ProviderRetryableError } from './errors.js';

export type { SpaceshipAdapter, DnsRecord };

const SPACESHIP_API_BASE = 'https://spaceship.dev/api/v1';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES_ON_5XX = 2;

function requireApiKey(): string {
  const key = process.env.LANDINGLAB_SPACESHIP_API_KEY;
  if (!key) {
    throw new ProviderConfigError(
      'LANDINGLAB_SPACESHIP_API_KEY not set — required for Squad 5 custom_domain flow',
      'spaceship',
    );
  }
  return key;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Política de repetição — obrigatória (sem default) para que nenhuma operação
 * nova herde o reenvio por acidente (Story 18.10e). `retryTransient: true` só
 * para operações seguras de repetir (GET, PUT idempotente); um POST que cobra
 * (register/renew) DEVE usar `false`: um 5xx pode vir depois de o Spaceship já
 * ter cobrado, e reenviar cobraria de novo.
 */
interface SpaceshipRetryPolicy {
  retryTransient: boolean;
}

async function spaceshipRequest(
  method: string,
  path: string,
  body: unknown,
  policy: SpaceshipRetryPolicy,
): Promise<Response> {
  const apiKey = requireApiKey();
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const maxRetries = policy.retryTransient ? MAX_RETRIES_ON_5XX : 0;

  for (let attempt = 1; ; attempt++) {
    const response = await fetchWithTimeout(`${SPACESHIP_API_BASE}${path}`, init);
    if (response.ok) return response;
    if ((response.status === 429 || response.status >= 500) && attempt <= maxRetries) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    const text = await response.text().catch(() => '');
    throw new ProviderRetryableError(
      `Spaceship ${method} ${path} failed with ${response.status}: ${text.slice(0, 200)}`,
      'spaceship',
      response.status,
    );
  }
}

/**
 * Factory — Wave 2 real impl. Env presence is checked lazily on first call
 * (worker bootstrap MUST NOT crash if LANDINGLAB_SPACESHIP_API_KEY is missing
 * during dev/CI). Subdomain deployments never invoke this — only custom_domain.
 */
export function createSpaceshipClient(): SpaceshipAdapter {
  return {
    async checkAvailability(domain: string) {
      const response = await spaceshipRequest(
        'GET',
        `/domains/check?domain=${encodeURIComponent(domain)}`,
        undefined,
        { retryTransient: true },
      );
      const data = (await response.json()) as { available?: boolean; price?: number };
      return {
        available: data.available === true,
        price: typeof data.price === 'number' ? data.price : undefined,
      };
    },

    async register(domain: string, opts: { years: number }) {
      // Cobra: um único envio, mesmo em 429/5xx (Story 18.10e).
      const response = await spaceshipRequest(
        'POST',
        `/domains/register`,
        { domain, years: opts.years },
        { retryTransient: false },
      );
      const data = (await response.json()) as { orderId?: string; id?: string };
      return { orderId: data.orderId ?? data.id ?? `unknown-${Date.now()}` };
    },

    async configureDNS(domain: string, records: DnsRecord[]) {
      // PUT substitui o conjunto de registros — idempotente, pode repetir.
      await spaceshipRequest(
        'PUT',
        `/dns/${encodeURIComponent(domain)}/records`,
        { records },
        { retryTransient: true },
      );
    },

    // Task #40 — domain lifecycle renewal.
    // Spaceship API: POST /domains/{domain}/renew  { years }
    // Documentação: https://spaceship.dev/api/v1/domains  (endpoint pode retornar
    // 404 se a conta não tem permissão / plano — nesse caso propagamos o erro
    // 501-equivalente pra rota do backoffice retornar mensagem clara.
    async renew(domain: string, opts: { years: number }) {
      const response = await spaceshipRequest(
        'POST',
        `/domains/${encodeURIComponent(domain)}/renew`,
        { years: opts.years },
        // Cobra: um único envio, mesmo em 429/5xx (Story 18.10e).
        { retryTransient: false },
      );
      const data = (await response.json().catch(() => ({}))) as {
        orderId?: string;
        id?: string;
        cost?: number;
        price?: number;
      };
      return {
        orderId: data.orderId ?? data.id ?? `renew-${Date.now()}`,
        cost:
          typeof data.cost === 'number'
            ? data.cost
            : typeof data.price === 'number'
              ? data.price
              : undefined,
      };
    },
  };
}

export { ProviderConfigError };

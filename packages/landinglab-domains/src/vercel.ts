/**
 * Vercel Domains adapter — attach/verify de domínios em projects Vercel.
 *
 * Story 13.8 Wave 2 (real impl): chamadas reais à Vercel API v10/v9 pra vincular
 * custom domains ao project landinglab-storefront e monitorar verificação
 * DNS/SSL Let's Encrypt.
 *
 * Endpoints:
 *   POST   /v10/projects/{projectId}/domains          (addDomainToProject)
 *   DELETE /v9/projects/{projectId}/domains/{domain}  (removeDomain)
 *   GET    /v9/projects/{projectId}/domains/{domain}/config (getDomainStatus)
 *
 * Env vars (lidas lazy no primeiro método call — worker bootstrap não bloqueia):
 *   LANDINGLAB_VERCEL_TOKEN       — API token, scope Domains
 *   LANDINGLAB_VERCEL_PROJECT_ID  — landinglab-storefront project ID
 */
import { UpstreamUnavailableError, createHttpClient } from '@blackshop/shared/http';

export interface VercelDomainsAdapter {
  /** Attach `domain` to Vercel `projectId`. Returns immediate verification status. */
  addDomainToProject(
    domain: string,
    projectId: string,
    token: string,
  ): Promise<{ verified: boolean; verificationToken?: string }>;

  /** Remove `domain` from Vercel `projectId`. Used by unpublish flow (Wave 3). */
  removeDomain(domain: string, projectId: string, token: string): Promise<void>;

  /**
   * Poll domain verification / SSL provisioning status.
   * `reason` is populated when verified=false (DNS mismatch, SSL pending, etc).
   */
  getDomainStatus(
    domain: string,
    projectId: string,
    token: string,
  ): Promise<{ verified: boolean; reason?: string }>;

  // ─── Legacy shape (preserved for @blackshop/landinglab-deploy Wave 1 stubs) ────
  attachDomain(projectId: string, domain: string): Promise<{ verified: boolean }>;
  pollVerification(
    projectId: string,
    domain: string,
  ): Promise<{ verified: boolean; reason?: string }>;
}

export class VercelDomainsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VercelDomainsConfigError';
  }
}

export class VercelDomainsHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'VercelDomainsHttpError';
  }
}

const VERCEL_API_BASE = 'https://api.vercel.com';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES_ON_5XX = 2;

// Story 18.2: transporte via cliente de @blackshop/shared/http (antes era uma cópia local de
// fetchWithTimeout). Mesmos limites: 1 + MAX_RETRIES_ON_5XX tentativas em 429/5xx, esperas de
// 500 ms e 1 s (500·2^n, sem jitter), prazo de 30 s por tentativa. Attach/remove de domínio são
// declarados idempotentes (o estado final é o mesmo; repetir só muda a resposta) para manter o
// retry em 5xx que o cliente já tinha. A resposta final volta para o mapeamento de sempre.
const vercelHttp = createHttpClient({
  label: 'vercel-domains',
  timeoutMs: REQUEST_TIMEOUT_MS,
  httpErrors: 'return',
  retry: {
    attempts: MAX_RETRIES_ON_5XX + 1,
    baseDelayMs: 500,
    maxDelayMs: 1_000,
    maxTotalMs: Number.POSITIVE_INFINITY,
    jitter: 'none',
    // Como antes: timeout/rede não eram repetidos (o pior caso continua 30 s, não 3 × 30 s — a
    // rota de publicação do backoffice roda numa função serverless).
    retryTransportErrors: false,
  },
});

async function vercelRequest(
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };

  let response: Response;
  try {
    ({ response } = await vercelHttp.request(url, init, { idempotent: true }));
  } catch (err) {
    // Contrato preservado: falha de rede propaga o erro original (timeout → UpstreamTimeoutError).
    if (err instanceof UpstreamUnavailableError && err.status === null && err.cause !== undefined) throw err.cause;
    throw err;
  }
  if (response.ok) return response;
  const text = await response.text().catch(() => '');
  throw new VercelDomainsHttpError(
    `Vercel API ${method} ${url} failed with ${response.status}`,
    response.status,
    text,
  );
}

/**
 * Factory — instantiates the Vercel Domains client.
 *
 * Wave 2: real HTTP client using fetch. Env vars are NOT read at construction —
 * they can be passed per-call by the orchestrator (which reads from process.env
 * or DI), keeping worker bootstrap failure-free.
 */
export function createVercelDomainsClient(): VercelDomainsAdapter {
  return {
    async addDomainToProject(domain, projectId, token) {
      if (!projectId || !token) {
        throw new VercelDomainsConfigError(
          'addDomainToProject: projectId and token are required',
        );
      }
      const url = `${VERCEL_API_BASE}/v10/projects/${encodeURIComponent(projectId)}/domains`;
      const response = await vercelRequest('POST', url, token, { name: domain });
      const data = (await response.json()) as {
        verified?: boolean;
        verification?: Array<{ type: string; value: string }>;
      };
      const txtVerification = data.verification?.find((v) => v.type === 'TXT');
      return {
        verified: data.verified === true,
        verificationToken: txtVerification?.value,
      };
    },

    async removeDomain(domain, projectId, token) {
      if (!projectId || !token) {
        throw new VercelDomainsConfigError(
          'removeDomain: projectId and token are required',
        );
      }
      const url = `${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`;
      await vercelRequest('DELETE', url, token);
    },

    async getDomainStatus(domain, projectId, token) {
      if (!projectId || !token) {
        throw new VercelDomainsConfigError(
          'getDomainStatus: projectId and token are required',
        );
      }
      const url = `${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}/config`;
      const response = await vercelRequest('GET', url, token);
      const data = (await response.json()) as {
        misconfigured?: boolean;
        acceptedChallenges?: string[];
      };
      // Vercel considers a domain "verified" when it's not misconfigured AND
      // has at least one accepted challenge (which implies SSL cert exists).
      const verified =
        data.misconfigured === false && (data.acceptedChallenges?.length ?? 0) > 0;
      return {
        verified,
        reason: verified
          ? undefined
          : data.misconfigured
            ? 'dns_misconfigured'
            : 'awaiting_ssl_challenge',
      };
    },

    // ─── Legacy shape shims — delegate to modern methods, reading env lazily ──
    async attachDomain(projectId, domain) {
      const token = process.env.LANDINGLAB_VERCEL_TOKEN ?? '';
      if (!token) {
        throw new VercelDomainsConfigError(
          'attachDomain: LANDINGLAB_VERCEL_TOKEN not set',
        );
      }
      const result = await this.addDomainToProject(domain, projectId, token);
      return { verified: result.verified };
    },
    async pollVerification(projectId, domain) {
      const token = process.env.LANDINGLAB_VERCEL_TOKEN ?? '';
      if (!token) {
        throw new VercelDomainsConfigError(
          'pollVerification: LANDINGLAB_VERCEL_TOKEN not set',
        );
      }
      return this.getDomainStatus(domain, projectId, token);
    },
  };
}

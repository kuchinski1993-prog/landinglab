// Porkbun provider — Squad 5 (Deploy) — Fase P.1
//
// Registrar de domínios low-cost com API grátis (sem minimum deposit).
// Docs: https://porkbun.com/api/json/v3/documentation
//
// Auth: cada request POST leva { apikey, secretapikey } no body.
// TLDs baratos: .click ($1.54), .top ($1.63), .online ($1.96), .xyz ($2.04)
//
// Env vars:
//   PORKBUN_API_KEY (pk1_...)
//   PORKBUN_SECRET_API_KEY (sk1_...)
//
// Estratégia: dono compra domínio 1x pelo backoffice, usa como "guarda-chuva".
// Todas as landings viram subdomínios (grátis via DNS wildcard).
// autoRenew=false por padrão — dono não vai renovar (dropshipping efêmero).

import { ProviderConfigError, ProviderRetryableError } from './errors.js';

const PORKBUN_API_BASE = 'https://api.porkbun.com/api/json/v3';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES_ON_5XX = 2;

interface PorkbunAuth {
  apikey: string;
  secretapikey: string;
}

function getAuth(): PorkbunAuth {
  const apikey = process.env['PORKBUN_API_KEY'];
  const secretapikey = process.env['PORKBUN_SECRET_API_KEY'];
  if (!apikey || !secretapikey) {
    throw new ProviderConfigError(
      'PORKBUN_API_KEY + PORKBUN_SECRET_API_KEY são obrigatórias pra Porkbun provider',
      'porkbun',
    );
  }
  return { apikey, secretapikey };
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
 * Porkbun API request. Todos os endpoints são POST com auth no body.
 * Retorna JSON já parseado. Lança ProviderRetryableError em 5xx/timeout.
 */
async function porkbunRequest<T = unknown>(
  path: string,
  extraBody: Record<string, unknown> = {},
): Promise<T> {
  const auth = getAuth();
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...auth, ...extraBody }),
  };

  let attempt = 0;
  while (true) {
    attempt++;
    let response: Response;
    try {
      response = await fetchWithTimeout(`${PORKBUN_API_BASE}${path}`, init);
    } catch (err) {
      if (attempt <= MAX_RETRIES_ON_5XX) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      throw new ProviderRetryableError(
        `Porkbun ${path} network error: ${err instanceof Error ? err.message : String(err)}`,
        'porkbun',
        0,
      );
    }

    if (response.ok) {
      const json = (await response.json()) as { status: string; message?: string } & T;
      if (json.status === 'SUCCESS') return json as T;
      // Porkbun retorna 200 com status:ERROR no body — trata como retryable se genérico
      const msg = json.message ?? 'unknown error';
      throw new ProviderRetryableError(
        `Porkbun ${path} returned status=ERROR: ${msg}`,
        'porkbun',
        200,
      );
    }

    if (
      (response.status === 429 || response.status >= 500) &&
      attempt <= MAX_RETRIES_ON_5XX
    ) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    const text = await response.text().catch(() => '');
    throw new ProviderRetryableError(
      `Porkbun ${path} failed with ${response.status}: ${text.slice(0, 200)}`,
      'porkbun',
      response.status,
    );
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface PorkbunPricingEntry {
  registration: string;
  renewal: string;
  transfer: string;
}

export interface PorkbunPricing {
  status: 'SUCCESS';
  pricing: Record<string, PorkbunPricingEntry>;
}

/**
 * Retorna preços de TODOS os TLDs suportados. Chamada leve (~10KB response),
 * pode cachear no worker por 1h.
 */
export async function getPricing(): Promise<PorkbunPricing> {
  return porkbunRequest<PorkbunPricing>('/pricing/get');
}

export interface DomainAvailability {
  available: boolean;
  premium: boolean;
  price: number | null;
  firstYearPromo: boolean;
}

/**
 * Checa disponibilidade de UM domínio (ex: 'meudominio.click').
 * Retorna preço real cotado pela Porkbun (não sempre bate com getPricing —
 * pode ter promo/premium). Latência ~500ms-1s.
 */
export async function checkAvailability(domain: string): Promise<DomainAvailability> {
  interface Response {
    status: 'SUCCESS';
    response: {
      avail: 'yes' | 'no';
      premium: 'yes' | 'no';
      price: string;
      firstYearPromo?: 'yes' | 'no';
    };
    limits: unknown;
  }
  const res = await porkbunRequest<Response>(`/domain/checkDomain/${domain}`);
  return {
    available: res.response.avail === 'yes',
    premium: res.response.premium === 'yes',
    price: res.response.price ? Number(res.response.price) : null,
    firstYearPromo: res.response.firstYearPromo === 'yes',
  };
}

export interface RegisterDomainInput {
  /** Domínio completo (ex: 'meudominio.click') */
  domain: string;
  /** Anos de registro. 1 = default e mais barato. */
  years?: number;
  /** Auto-renovação. Default false (dropshipping = efêmero). */
  autoRenew?: boolean;
  /** WHOIS privacy. Default true (grátis na Porkbun). */
  whoisPrivacy?: boolean;
  /** Nameservers custom. Default = nameservers Porkbun (curitiba.ns.porkbun.com etc) */
  nameservers?: string[];
}

export interface RegisterDomainResult {
  status: 'SUCCESS';
  message?: string;
}

/**
 * Compra domínio via Porkbun. Debita do saldo da conta configurada nas API keys.
 * Retorna sucesso ou lança ProviderRetryableError se saldo insuficiente/domínio
 * indisponível/etc.
 *
 * ATENÇÃO: essa chamada GASTA DINHEIRO REAL do saldo Porkbun.
 * Sempre confirme antes de invocar.
 */
export async function registerDomain(input: RegisterDomainInput): Promise<RegisterDomainResult> {
  const body: Record<string, unknown> = {
    domain: input.domain,
    years: input.years ?? 1,
    autorenew: input.autoRenew === true ? '1' : '0',
    whoisPrivacy: input.whoisPrivacy === false ? '0' : '1',
  };
  if (input.nameservers && input.nameservers.length > 0) {
    body['ns'] = input.nameservers;
  }
  return porkbunRequest<RegisterDomainResult>('/domain/create', body);
}

export interface DnsRecord {
  /** Nome do registro. '' = raiz (@). Ex: '*' pra wildcard. */
  name: string;
  /** Tipo DNS: A, AAAA, CNAME, MX, TXT, SRV, etc. */
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'ALIAS' | 'NS';
  /** Valor: IP pra A, hostname pra CNAME, etc. */
  content: string;
  /** TTL em segundos. Default Porkbun = 600. */
  ttl?: number;
  /** Prio (só pra MX/SRV). */
  prio?: number;
}

/**
 * Cria um record DNS no domínio. Retorna o ID do record criado.
 * Usado pra apontar wildcard (*.dominio.com) pro Vercel.
 */
export async function createDnsRecord(
  domain: string,
  record: DnsRecord,
): Promise<{ status: 'SUCCESS'; id: number }> {
  return porkbunRequest<{ status: 'SUCCESS'; id: number }>(
    `/dns/create/${domain}`,
    {
      name: record.name,
      type: record.type,
      content: record.content,
      ttl: (record.ttl ?? 600).toString(),
      ...(record.prio !== undefined && { prio: record.prio.toString() }),
    },
  );
}

export interface RetrievedDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: string;
  prio: string;
  notes: string;
}

/**
 * Lista todos os records DNS de um domínio.
 */
export async function listDnsRecords(
  domain: string,
): Promise<{ status: 'SUCCESS'; records: RetrievedDnsRecord[] }> {
  return porkbunRequest<{ status: 'SUCCESS'; records: RetrievedDnsRecord[] }>(
    `/dns/retrieve/${domain}`,
  );
}

/**
 * Deleta um record DNS pelo ID (obtido via listDnsRecords).
 */
export async function deleteDnsRecord(
  domain: string,
  recordId: string,
): Promise<{ status: 'SUCCESS' }> {
  return porkbunRequest<{ status: 'SUCCESS' }>(`/dns/delete/${domain}/${recordId}`);
}

/**
 * Health check — testa se as credenciais estão OK.
 * Chama /ping que retorna { status: SUCCESS, yourIp: '...' } sem gastar nada.
 */
export async function ping(): Promise<{ status: 'SUCCESS'; yourIp: string }> {
  return porkbunRequest<{ status: 'SUCCESS'; yourIp: string }>('/ping');
}

// Story 13.10 — cliente Porkbun mínimo das rotas /api/landing-domains/*.
//
// Formato validado contra a spec OpenAPI v3 da Porkbun (2026-10-10,
// https://porkbun.com/api/json/v3/spec) e contra a compra real em produção:
//   - POST /domain/checkDomain/{domain}   → disponibilidade + preço (USD string)
//   - POST /domain/checkDomain            → lote (até 25 domínios, 200/60 s)
//   - GET  /pricing/get                   → preço por TLD (sem auth)
//   - POST /domain/create/{domain}        → { cost (centavos), agreeToTerms }
//                                           resposta com `balance` em centavos
//   - POST /domain/updateAutoRenew/{d}    → { status: 'off' }
//   - POST /domain/listAll                → filtro `domain` (recuperação de timeout)
//   - GET  /account/balance               → saldo ao vivo em centavos
//
// Segredos: as chaves vão SOMENTE no body/headers da chamada. Nenhuma função
// deste módulo loga, devolve ou inclui as chaves em mensagens de erro.

export const PORKBUN_API_BASE = 'https://api.porkbun.com/api/json/v3';

export interface PorkbunCredentials {
  apikey: string;
  secretapikey: string;
}

/** Lê as chaves do ambiente. `null` = não configuradas. */
export function getPorkbunCredentials(): PorkbunCredentials | null {
  const apikey = process.env['PORKBUN_API_KEY'];
  const secretapikey = process.env['PORKBUN_SECRET_API_KEY'];
  if (!apikey || !secretapikey) return null;
  return { apikey, secretapikey };
}

/** Erro 429 da Porkbun (RATE_LIMIT_EXCEEDED). */
export class PorkbunRateLimitError extends Error {
  readonly retryAfterSec: number | null;
  constructor(retryAfterSec: number | null) {
    super('Porkbun: limite de consultas atingido');
    this.name = 'PorkbunRateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

interface RawResult {
  httpStatus: number;
  json: Record<string, unknown> | null;
  retryAfterSec: number | null;
}

function parseRetryAfter(res: Response, json: Record<string, unknown> | null): number | null {
  const header = res.headers.get('retry-after');
  const fromHeader = header ? Number(header) : NaN;
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;
  const ttl = json ? Number(json['ttlRemaining'] ?? json['retryAfter']) : NaN;
  return Number.isFinite(ttl) && ttl >= 0 ? ttl : null;
}

async function request(
  path: string,
  init: { method: 'GET' | 'POST'; body?: Record<string, unknown>; headers?: Record<string, string> },
  timeoutMs: number,
): Promise<RawResult> {
  const res = await fetch(`${PORKBUN_API_BASE}${path}`, {
    method: init.method,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  const rateLimited =
    res.status === 429 || (json !== null && json['code'] === 'RATE_LIMIT_EXCEEDED');
  return {
    httpStatus: res.status,
    json,
    retryAfterSec: rateLimited ? parseRetryAfter(res, json) : null,
  };
}

function isRateLimited(r: RawResult): boolean {
  return r.httpStatus === 429 || (r.json !== null && r.json['code'] === 'RATE_LIMIT_EXCEEDED');
}

// ─── Preços em centavos ──────────────────────────────────────────────────

/** "1.96" → 196. Inválido/ausente → null. */
export function usdToCents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function formatUsd(cents: number): string {
  return `US$ ${(cents / 100).toFixed(2)}`;
}

// ─── Pricing por TLD (/pricing/get) ──────────────────────────────────────

export interface TldPrice {
  tld: string;
  registrationCents: number;
  renewalCents: number | null;
}

const PRICING_TTL_MS = 60 * 60 * 1000;
let pricingCache: { at: number; data: TldPrice[] } | null = null;

/** Limpa o cache de preços por TLD (testes). */
export function resetPricingCache(): void {
  pricingCache = null;
}

/**
 * Preços padrão de todos os TLDs (endpoint público, sem auth).
 * Cache em memória de 1 h por instância — a tabela muda raramente e a
 * disponibilidade/preço real de cada candidato vem do checkDomain.
 */
export async function fetchTldPricing(now: number = Date.now()): Promise<TldPrice[]> {
  if (pricingCache && now - pricingCache.at < PRICING_TTL_MS) return pricingCache.data;
  const r = await request('/pricing/get', { method: 'GET' }, 15_000);
  if (isRateLimited(r)) throw new PorkbunRateLimitError(r.retryAfterSec);
  const pricing = r.json?.['pricing'];
  if (r.json?.['status'] !== 'SUCCESS' || !pricing || typeof pricing !== 'object') {
    throw new Error('Porkbun /pricing/get retornou erro');
  }
  const data: TldPrice[] = [];
  for (const [tld, raw] of Object.entries(pricing as Record<string, Record<string, unknown>>)) {
    if (!raw || typeof raw !== 'object' || raw['specialType']) continue;
    const registrationCents = usdToCents(raw['registration']);
    if (registrationCents === null || registrationCents === 0) continue;
    data.push({ tld: tld.toLowerCase(), registrationCents, renewalCents: usdToCents(raw['renewal']) });
  }
  data.sort((a, b) => a.registrationCents - b.registrationCents || a.tld.localeCompare(b.tld));
  pricingCache = { at: now, data };
  return data;
}

// ─── Disponibilidade (/domain/checkDomain) ───────────────────────────────

export type QuoteStatus = 'available' | 'unavailable' | 'premium' | 'unknown' | 'invalid';

export interface DomainQuote {
  domain: string;
  tld: string;
  status: QuoteStatus;
  /** Preço do 1º ano em centavos de USD. */
  priceCents: number | null;
  /** Preço de renovação anual em centavos de USD. */
  renewalCents: number | null;
  firstYearPromo: boolean;
  /** Renovação ≥ 2× o 1º ano (ex.: .online US$1,96 → US$28,84). */
  renewalMuchHigher: boolean;
  /** Motivo quando não disponível/indeterminado. */
  reason?: string;
  /**
   * Porkbun informou que o domínio JÁ está na nossa conta (`inYourAccount`).
   * Hotfix REL-001: a compra trata isso como recuperação (grava o domínio,
   * sem cobrar de novo) em vez de "indisponível".
   */
  inYourAccount?: boolean;
}

export function tldOf(domain: string): string {
  return domain.split('.').slice(1).join('.');
}

export function renewalMuchHigher(priceCents: number | null, renewalCents: number | null): boolean {
  if (priceCents === null || renewalCents === null || priceCents <= 0) return false;
  return renewalCents >= priceCents * 2;
}

/** Converte o `response` do checkDomain (single ou item do lote) em quote. */
export function quoteFromCheckResponse(domain: string, raw: unknown): DomainQuote {
  const r = (raw ?? {}) as Record<string, unknown>;
  const additional = (r['additional'] ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const priceCents = usdToCents(r['price']);
  const renewalCents = usdToCents(additional['renewal']?.['price']) ?? usdToCents(r['regularPrice']);
  const minDuration = Number(r['minDuration'] ?? 1);
  const base = {
    domain,
    tld: tldOf(domain),
    priceCents,
    renewalCents,
    firstYearPromo: r['firstYearPromo'] === 'yes',
    renewalMuchHigher: renewalMuchHigher(priceCents, renewalCents),
  };
  if (r['premium'] === 'yes') {
    return { ...base, status: 'premium', reason: 'Domínio premium (não comprável pela API)' };
  }
  if (r['avail'] !== 'yes') {
    const inYourAccount = r['inYourAccount'] === true || r['inYourAccount'] === 'yes';
    return {
      ...base,
      status: 'unavailable',
      reason: inYourAccount ? 'Já está na sua conta Porkbun' : 'Já registrado',
      ...(inYourAccount ? { inYourAccount: true } : {}),
    };
  }
  if (Number.isFinite(minDuration) && minDuration > 1) {
    return { ...base, status: 'unavailable', reason: `Registro mínimo de ${minDuration} anos` };
  }
  if (priceCents === null) {
    return { ...base, status: 'unknown', reason: 'Porkbun não informou o preço' };
  }
  return { ...base, status: 'available' };
}

export function unknownQuote(domain: string, reason: string): DomainQuote {
  return {
    domain,
    tld: tldOf(domain),
    status: 'unknown',
    priceCents: null,
    renewalCents: null,
    firstYearPromo: false,
    renewalMuchHigher: false,
    reason,
  };
}

/** Consulta um domínio. Lança PorkbunRateLimitError em 429. */
export async function checkDomain(creds: PorkbunCredentials, domain: string): Promise<DomainQuote> {
  const r = await request(
    `/domain/checkDomain/${encodeURIComponent(domain)}`,
    { method: 'POST', body: { ...creds } },
    15_000,
  );
  if (isRateLimited(r)) throw new PorkbunRateLimitError(r.retryAfterSec);
  if (r.json?.['status'] !== 'SUCCESS' || !r.json['response']) {
    const msg = typeof r.json?.['message'] === 'string' ? (r.json['message'] as string) : null;
    return unknownQuote(domain, msg ? `Porkbun: ${msg.slice(0, 200)}` : 'Falha na consulta da Porkbun');
  }
  return quoteFromCheckResponse(domain, r.json['response']);
}

export const BULK_CHECK_MAX = 25;

/**
 * Consulta até 25 domínios numa chamada (orçamento separado: 200 domínios/60 s).
 * Resultados parciais: `unresolved` vira `unknown` (não é "indisponível").
 * Lança PorkbunRateLimitError em 429; outros erros lançam Error.
 */
export async function checkDomainsBulk(
  creds: PorkbunCredentials,
  domains: string[],
): Promise<DomainQuote[]> {
  const list = [...new Set(domains)].slice(0, BULK_CHECK_MAX);
  if (list.length === 0) return [];
  const r = await request(
    '/domain/checkDomain',
    { method: 'POST', body: { ...creds, domains: list } },
    20_000,
  );
  if (isRateLimited(r)) throw new PorkbunRateLimitError(r.retryAfterSec);
  if (r.json?.['status'] !== 'SUCCESS') {
    throw new Error('Porkbun checkDomain em lote retornou erro');
  }
  const answered = (r.json['domains'] ?? {}) as Record<string, unknown>;
  const invalid = new Set(
    ((r.json['invalid'] ?? []) as Array<Record<string, unknown> | string>).map((i) =>
      String(typeof i === 'string' ? i : (i['domain'] ?? '')).toLowerCase(),
    ),
  );
  return list.map((d) => {
    if (answered[d]) return quoteFromCheckResponse(d, answered[d]);
    if (invalid.has(d)) return { ...unknownQuote(d, 'Não verificável na Porkbun'), status: 'invalid' as const };
    return unknownQuote(d, 'Registro não respondeu — tente de novo');
  });
}

// ─── Compra (/domain/create/{domain}) ────────────────────────────────────

export interface CreateDomainResult {
  /**
   * - success: comprado.
   * - already_owned: "already registered" — pode ser de terceiros; o caller
   *   confere a conta (listAll).
   * - in_your_account: a Porkbun diz que o domínio JÁ está na nossa conta →
   *   recuperação (gravar, sem cobrar de novo).
   * - indeterminate: HTTP >= 500 ou resposta sem JSON — a Porkbun PODE ter
   *   processado (ex.: 502/524 de gateway). Mesmo tratamento do timeout.
   * - insufficient_funds / rejected: recusa definitiva, nada comprado.
   */
  outcome:
    | 'success'
    | 'already_owned'
    | 'in_your_account'
    | 'indeterminate'
    | 'insufficient_funds'
    | 'rejected';
  /** Saldo restante em centavos (quando a Porkbun informa). */
  balanceCents: number | null;
  chargedCents: number | null;
  code: string | null;
  message: string | null;
}

/**
 * Monta o body do domain/create. `autorenew` é SEMPRE 'off' (decisão do
 * operador: nunca auto-renovar) — não há parâmetro para mudar isso.
 */
export function buildCreateDomainBody(
  creds: PorkbunCredentials,
  costCents: number,
): Record<string, unknown> {
  return {
    apikey: creds.apikey,
    secretapikey: creds.secretapikey,
    cost: costCents,
    agreeToTerms: 'yes',
    autorenew: 'off',
  };
}

/** Compra. Erros de rede/timeout propagam (o caller faz a recuperação via listAll). */
export async function createDomain(
  creds: PorkbunCredentials,
  domain: string,
  costCents: number,
  timeoutMs = 25_000,
): Promise<CreateDomainResult> {
  const r = await request(
    `/domain/create/${encodeURIComponent(domain)}`,
    { method: 'POST', body: buildCreateDomainBody(creds, costCents) },
    timeoutMs,
  );
  const json = r.json ?? {};
  const balanceRaw = json['balance'] ?? json['balance_cents'];
  const balanceCents = Number.isFinite(Number(balanceRaw)) && balanceRaw !== null && balanceRaw !== undefined
    ? Math.round(Number(balanceRaw))
    : null;
  const chargedCents = Number.isFinite(Number(json['cost'])) ? Math.round(Number(json['cost'])) : null;
  const code = typeof json['code'] === 'string' ? (json['code'] as string) : null;
  const message = typeof json['message'] === 'string' ? (json['message'] as string) : null;
  if (json['status'] === 'SUCCESS') {
    return { outcome: 'success', balanceCents, chargedCents, code, message };
  }
  // Hotfix REL-001: 5xx ou corpo não-JSON → resultado indeterminado (pode ter
  // sido processado do lado da Porkbun antes do erro de gateway).
  if (r.httpStatus >= 500 || r.json === null) {
    return { outcome: 'indeterminate', balanceCents, chargedCents, code, message };
  }
  const lower = (message ?? '').toLowerCase();
  if (
    json['inYourAccount'] === true ||
    json['inYourAccount'] === 'yes' ||
    lower.includes('in your account') ||
    lower.includes('já está na sua conta')
  ) {
    return { outcome: 'in_your_account', balanceCents, chargedCents, code, message };
  }
  if (code === 'INSUFFICIENT_FUNDS' || lower.includes('insufficient')) {
    return { outcome: 'insufficient_funds', balanceCents, chargedCents, code, message };
  }
  if (lower.includes('already') || lower.includes('duplicate') || lower.includes('exists')) {
    return { outcome: 'already_owned', balanceCents, chargedCents, code, message };
  }
  return { outcome: 'rejected', balanceCents, chargedCents, code, message };
}

/**
 * Desliga auto-renovação (garantia extra pós-compra). Nunca lança.
 *
 * Hotfix REL-002: o endpoint responde `{ status, results: { [domain]: { status,
 * message } } }` — o status do topo pode ser SUCCESS mesmo com falha no
 * domínio. Só conta como desligado se `results[domain].status === 'SUCCESS'`.
 */
export async function disableAutoRenew(creds: PorkbunCredentials, domain: string): Promise<boolean> {
  try {
    const r = await request(
      `/domain/updateAutoRenew/${encodeURIComponent(domain)}`,
      { method: 'POST', body: { ...creds, status: 'off' } },
      10_000,
    );
    if (r.json?.['status'] !== 'SUCCESS') return false;
    const results = r.json['results'];
    if (!results || typeof results !== 'object') return false;
    const entry = (results as Record<string, unknown>)[domain];
    if (!entry || typeof entry !== 'object') return false;
    return (entry as Record<string, unknown>)['status'] === 'SUCCESS';
  } catch {
    return false;
  }
}

/**
 * true se o domínio está na conta (recuperação de timeout/resultado
 * indeterminado). Nunca lança.
 *
 * Hotfix REL-001: aceita qualquer status do domínio na conta (logo após a
 * compra ele pode ainda não estar ACTIVE) — se aparece no listAll, é nosso.
 */
export async function isDomainInAccount(creds: PorkbunCredentials, domain: string): Promise<boolean> {
  try {
    const r = await request(
      '/domain/listAll',
      { method: 'POST', body: { ...creds, domain } },
      8_000,
    );
    const domains = (r.json?.['domains'] ?? []) as Array<{ domain?: string; status?: string }>;
    return domains.some((d) => typeof d.domain === 'string' && d.domain.toLowerCase() === domain);
  } catch {
    return false;
  }
}

// ─── Saldo ao vivo (/account/balance) ────────────────────────────────────

/** Saldo em centavos; `null` se o endpoint falhar. Nunca lança. */
export async function fetchLiveBalance(creds: PorkbunCredentials): Promise<number | null> {
  try {
    const r = await request(
      '/account/balance',
      {
        method: 'GET',
        headers: { 'X-API-Key': creds.apikey, 'X-Secret-API-Key': creds.secretapikey },
      },
      8_000,
    );
    if (r.json?.['status'] !== 'SUCCESS') return null;
    const n = Number(r.json['balance']);
    return Number.isFinite(n) ? Math.round(n) : null;
  } catch {
    return null;
  }
}

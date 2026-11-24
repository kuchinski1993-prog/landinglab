// Domínios do VSL G3 (blackshop_domains): adicionar, instruções de DNS, "Verificar agora"
// (DNS via DNS-over-HTTPS + HTTPS GET /__vsl/health do runtime), anexo ao projeto Vercel
// (blackshop-vsl-storefront) quando há token, remoção segura e listagem com status traduzível.
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import type { Sql } from 'postgres';
import { parse as parseDomain } from 'tldts';

import { isPrivateAddress } from '../../shared/src/http/private-address.js';

import { normalizeVslHostname } from './domains.js';
import { vslError } from './errors.js';

export const VERCEL_CNAME_TARGET = 'cname.vercel-dns.com';
export const VERCEL_APEX_A = '76.76.21.21';
export const VSL_RUNTIME_SERVICE = 'blackshop-vsl-runtime';
export const VSL_HEALTH_PATH = '/__vsl/health';
export const VSL_VERCEL_PROJECT_NAME = 'blackshop-vsl-storefront';
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const RESERVED_SUFFIXES = ['vercel.app', 'vercel-dns.com', 'now.sh', 'cloudflarestream.com', 'videodelivery.net', 'workers.dev', 'pages.dev', 'up.railway.app'];
/**
 * Domínios do LandingLab servidos por sufixo/wildcard (`*.cubipiccanti.online`, `*.landinglab.app`) e sem
 * linha própria em `landing_domains`. Reservados no código (QA F4 M2): anexar um deles ao projeto Vercel do
 * VSL tiraria a landing do ar. `LANDING_DOMAIN_SUFFIXES` e `VSL_RESERVED_DOMAINS` somam a esta lista.
 */
export const LANDINGLAB_RESERVED_SUFFIXES = ['cubipiccanti.online', 'landinglab.app'] as const;
const TLS_ERRORS = /CERT|SSL|TLS|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY/i;

export interface DnsInstruction { type: 'A' | 'CNAME' | 'TXT'; name: string; host: string; value: string; reason?: string }
export interface VercelVerification { type: string; domain: string; value: string; reason?: string }
export interface VercelAttachResult { status: 'attached' | 'already_attached' | 'conflict'; verified?: boolean; verification?: VercelVerification[] }

/** Porta mínima para anexar/remover domínio no projeto Vercel do runtime VSL. */
export interface VercelProjectDomains {
  attach(hostname: string): Promise<VercelAttachResult>;
  detach(hostname: string): Promise<void>;
}

/** Alvo do GET de health já com o IP validado pelo DoH (pin). */
export interface VslHealthTarget { hostname: string; address: string; family: 4 | 6; path: string; timeoutMs: number; port?: number }
export type VslHealthProbe = (target: VslHealthTarget) => Promise<{ status: number; body: string }>;

export interface DomainServiceDeps {
  fetch?: typeof fetch;
  /** GET de health; padrão = HTTPS conectando no IP validado (SNI/Host = hostname), sem seguir redirect. */
  healthProbe?: VslHealthProbe;
  env?: NodeJS.ProcessEnv;
  /** null = sem token/projeto: a UI mostra a instrução manual. */
  vercel?: VercelProjectDomains | null;
  timeoutMs?: number;
}

/** Cliente Vercel (v10/v9) — só criado se houver token + VSL_VERCEL_PROJECT_ID. */
export function vercelProjectDomainsFromEnv(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): VercelProjectDomains | null {
  const token = env['VSL_VERCEL_TOKEN'] || env['LANDINGLAB_VERCEL_TOKEN'];
  const projectId = env['VSL_VERCEL_PROJECT_ID'];
  if (!token || !projectId) return null;
  const team = env['VSL_VERCEL_TEAM_ID'] ? `?teamId=${encodeURIComponent(env['VSL_VERCEL_TEAM_ID'])}` : '';
  const base = `https://api.vercel.com`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const call = (method: string, path: string, body?: unknown) => fetcher(`${base}${path}${team}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const project = encodeURIComponent(projectId);
  const parse = async (response: Response) => (await response.json().catch(() => ({}))) as { verified?: boolean; verification?: VercelVerification[] };
  return {
    async attach(hostname) {
      const created = await call('POST', `/v10/projects/${project}/domains`, { name: hostname });
      if (created.ok) { const data = await parse(created); return { status: 'attached', verified: data.verified === true, verification: data.verification ?? [] }; }
      if (created.status === 409) {
        // 409 = já existe no projeto OU está em outro projeto/time. Confere no nosso projeto.
        const existing = await call('GET', `/v9/projects/${project}/domains/${encodeURIComponent(hostname)}`);
        if (existing.ok) { const data = await parse(existing); return { status: 'already_attached', verified: data.verified === true, verification: data.verification ?? [] }; }
        if (existing.status === 404) return { status: 'conflict' };
      }
      throw new Error(`Vercel domains API failed with ${created.status}`);
    },
    async detach(hostname) {
      const response = await call('DELETE', `/v9/projects/${project}/domains/${encodeURIComponent(hostname)}`);
      if (!response.ok && response.status !== 404) throw new Error(`Vercel domains API failed with ${response.status}`);
    },
  };
}

interface DomainRow {
  id: string; hostname: string; registrar: string | null; dns_status: string; ssl_status: string; lifecycle_status: string;
  last_checked_at: Date | null; last_check: DomainCheck | Record<string, never>; version: number; created_at: Date; updated_at: Date;
}
export interface DomainCheck {
  checkedAt: string;
  dns: { ok: boolean; code: string; records: Array<{ type: string; data: string }>; private?: boolean; pinned?: string };
  health: { ok: boolean; code: string; status?: number };
  vercel: { mode: 'api' | 'manual'; attached: boolean; code: string; verification?: VercelVerification[]; message?: string };
  degraded?: boolean;
}

export interface VslDomainView {
  id: string; hostname: string; isApex: boolean; registrar: string | null;
  dnsStatus: string; sslStatus: string; lifecycleStatus: string;
  status: { code: DomainStatusCode; message: string };
  instructions: DnsInstruction[];
  vercel: DomainCheck['vercel'];
  lastCheckedAt: Date | null; lastCheck: DomainCheck | null;
  inUse: boolean; version: number; updatedAt: Date;
}

const STATUS_MESSAGES = {
  active: 'Ativo — pronto para publicar.',
  pending_dns: 'Aguardando configuração de DNS.',
  dns_mismatch: 'O DNS aponta para outro lugar. Confira o registro indicado.',
  pending_ssl: 'DNS ok; aguardando o certificado SSL.',
  runtime_unreachable: `DNS ok, mas o domínio não responde pelo VSL. Anexe o domínio ao projeto ${VSL_VERCEL_PROJECT_NAME} na Vercel.`,
  archived: 'Removido.',
  suspended: 'Suspenso — não está servindo páginas. Reative para voltar a publicar.',
} as const;
export type DomainStatusCode = keyof typeof STATUS_MESSAGES;

export function isApexHostname(hostname: string): boolean {
  return parseDomain(hostname).domain === hostname;
}

export function dnsInstructions(hostname: string, verification: VercelVerification[] = []): DnsInstruction[] {
  const parsed = parseDomain(hostname);
  const apex = parsed.domain === hostname;
  const records: DnsInstruction[] = apex
    ? [{ type: 'A', name: '@', host: hostname, value: VERCEL_APEX_A }]
    : [{ type: 'CNAME', name: parsed.subdomain ?? hostname, host: hostname, value: VERCEL_CNAME_TARGET }];
  for (const item of verification)
    if (item.type === 'TXT') records.push({ type: 'TXT', name: item.domain.endsWith(`.${parsed.domain}`) ? item.domain.slice(0, -(parsed.domain!.length + 1)) : item.domain,
      host: item.domain, value: item.value, reason: 'Verificação de propriedade exigida pela Vercel.' });
  return records;
}

export function domainStatus(row: Pick<DomainRow, 'dns_status' | 'ssl_status' | 'lifecycle_status' | 'last_check'>): { code: DomainStatusCode; message: string } {
  let code: DomainStatusCode;
  const check = row.last_check as Partial<DomainCheck>;
  if (row.lifecycle_status === 'archived') code = 'archived';
  else if (row.lifecycle_status === 'active') code = 'active';
  else if (row.lifecycle_status === 'suspended' || row.lifecycle_status === 'expired') code = 'suspended';
  else if (row.dns_status === 'failed') code = 'dns_mismatch';
  else if (row.dns_status !== 'verified') code = 'pending_dns';
  else if (check.health && !check.health.ok && check.health.code === 'runtime_marker_missing') code = 'runtime_unreachable';
  else code = 'pending_ssl';
  return { code, message: STATUS_MESSAGES[code] };
}

// Faixas que a API nunca deve sondar (QA F4 M3). Story 18.2: a lista mora em
// packages/shared/src/http/private-address.ts (`isPrivateAddress`, mesmas faixas); o nome do VSL vira alias.
// Caminho relativo: entra no bundle Vercel do vsl-storefront (ver safe-fetch.ts).
/** IP privado/loopback/link-local/reservado (v4 e v6, inclusive v4 mapeado em v6). Texto que não é IP conta como bloqueado. */
export const isPrivateVslAddress: (ip: string) => boolean = isPrivateAddress;

/**
 * GET HTTPS de health conectando no IP já validado (sem nova resolução pelo DNS do sistema → sem
 * DNS rebinding), com SNI e Host = hostname, sem seguir redirect, com timeout e corpo limitado a 64 KB.
 */
export const pinnedHealthProbe: VslHealthProbe = ({ hostname, address, family, path, timeoutMs, port = 443 }) =>
  new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_name, options, callback) => {
      if ((options as { all?: boolean }).all) (callback as unknown as (err: null, list: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const req = httpsRequest({ host: hostname, servername: hostname, port, path, method: 'GET', lookup, agent: false,
      headers: { host: hostname, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; if (body.length > 65_536) res.destroy(new Error('health body too large')); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });

export class VslDomainService {
  private readonly fetcher: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly vercel: VercelProjectDomains | null;
  private readonly timeoutMs: number;
  private readonly healthProbe: VslHealthProbe;
  constructor(readonly sql: Sql, deps: DomainServiceDeps = {}) {
    this.fetcher = deps.fetch ?? fetch;
    this.healthProbe = deps.healthProbe ?? pinnedHealthProbe;
    this.env = deps.env ?? process.env;
    this.vercel = deps.vercel === undefined ? vercelProjectDomainsFromEnv(this.env, this.fetcher) : deps.vercel;
    this.timeoutMs = deps.timeoutMs ?? 8000;
  }

  private view(row: DomainRow & { in_use?: boolean }): VslDomainView {
    const check = row.last_check as Partial<DomainCheck>;
    const lastCheck: DomainCheck | null = Object.keys(check).length ? check as DomainCheck : null;
    return {
      id: row.id, hostname: row.hostname, isApex: isApexHostname(row.hostname), registrar: row.registrar,
      dnsStatus: row.dns_status, sslStatus: row.ssl_status, lifecycleStatus: row.lifecycle_status,
      status: domainStatus(row), instructions: dnsInstructions(row.hostname, check.vercel?.verification),
      vercel: check.vercel ?? (this.vercel ? { mode: 'api' as const, attached: false, code: 'not_checked' } : this.manualVercel()),
      lastCheckedAt: row.last_checked_at, lastCheck,
      inUse: Boolean(row.in_use), version: row.version, updatedAt: row.updated_at,
    };
  }
  private manualVercel(): DomainCheck['vercel'] {
    return { mode: 'manual', attached: false, code: 'manual_attach_required',
      message: `Anexe o domínio ao projeto ${VSL_VERCEL_PROJECT_NAME} na Vercel (Settings → Domains).` };
  }

  async list() {
    const rows = await this.sql<Array<DomainRow & { in_use: boolean }>>`SELECT d.*, EXISTS (SELECT 1 FROM vsl_public_routes r WHERE r.domain_id=d.id AND r.publication_status='published') AS in_use
      FROM blackshop_domains d WHERE d.lifecycle_status<>'archived' ORDER BY d.hostname`;
    return rows.map((row) => this.view(row));
  }

  async get(id: string) {
    const [row] = await this.sql<Array<DomainRow & { in_use: boolean }>>`SELECT d.*, EXISTS (SELECT 1 FROM vsl_public_routes r WHERE r.domain_id=d.id AND r.publication_status='published') AS in_use
      FROM blackshop_domains d WHERE d.id=${id} AND d.lifecycle_status<>'archived'`;
    if (!row) throw vslError('domain_not_found');
    return this.view(row);
  }

  /**
   * Valida o hostname: formato, sufixo público, reservados e conflito com o LandingLab.
   * - `domain_reserved`: sufixos de infraestrutura, prévia do VSL e `VSL_RESERVED_DOMAINS`;
   * - `domain_reserved_landinglab`: sob `cubipiccanti.online`/`landinglab.app` (+ `LANDING_DOMAIN_SUFFIXES`) ou sob
   *   um apex que o LandingLab já usa em `landing_domains` (o LandingLab serve `sub.apex` como slug do apex);
   * - `domain_landinglab_conflict`: o próprio domínio (ou o par apex/www) está em `landing_domains`.
   */
  async validateHostname(raw: unknown): Promise<string> {
    let hostname: string;
    try { hostname = normalizeVslHostname(String(raw ?? '')); } catch { throw vslError('domain_invalid'); }
    const parsed = parseDomain(hostname);
    if (!parsed.domain || parsed.isIp || !parsed.publicSuffix || hostname === parsed.publicSuffix) throw vslError('domain_invalid');
    const under = (suffix: string) => hostname === suffix || hostname.endsWith(`.${suffix}`);
    const list = (value: string | undefined) => (value ?? '').split(',').map((item) => item.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);
    const preview = (this.env['VSL_PREVIEW_DOMAIN'] ?? '').toLowerCase();
    const reserved = [...RESERVED_SUFFIXES, ...(preview ? [preview] : []), ...list(this.env['VSL_RESERVED_DOMAINS'])];
    if (reserved.some(under)) throw vslError('domain_reserved');
    const landinglabSuffixes = [...LANDINGLAB_RESERVED_SUFFIXES, ...list(this.env['LANDING_DOMAIN_SUFFIXES'])];
    if (landinglabSuffixes.some(under)) throw vslError('domain_reserved_landinglab');
    // Vercel pareia apex e www (redirect): os dois lados contam como do LandingLab.
    const apex = parsed.domain;
    const twins = hostname === apex ? [hostname, `www.${apex}`] : hostname === `www.${apex}` ? [hostname, apex] : [hostname];
    const [landing] = await this.sql`SELECT domain FROM landing_domains WHERE lower(domain) IN ${this.sql(twins)} LIMIT 1`;
    if (landing) throw vslError('domain_landinglab_conflict', { landingDomain: landing.domain });
    // Apex já usado pelo LandingLab (consultado na hora): qualquer subdomínio dele fica reservado.
    const [sibling] = await this.sql`SELECT domain FROM landing_domains
      WHERE lower(domain)=${apex} OR right(lower(domain), ${apex.length + 1})=${`.${apex}`} LIMIT 1`;
    if (sibling) throw vslError('domain_reserved_landinglab', { landingDomain: sibling.domain });
    return hostname;
  }

  /** Adiciona (ou reativa um removido). Mesmo hostname ativo = idempotente (created=false). */
  async add(raw: unknown, registrar?: string | null): Promise<{ domain: VslDomainView; created: boolean }> {
    const hostname = await this.validateHostname(raw);
    const [existing] = await this.sql<DomainRow[]>`SELECT * FROM blackshop_domains WHERE hostname=${hostname}`;
    if (existing && existing.lifecycle_status !== 'archived') return { domain: await this.get(existing.id), created: false };
    if (existing) {
      await this.sql`UPDATE blackshop_domains SET lifecycle_status='registered',dns_status='unknown',ssl_status='unknown',last_check='{}'::jsonb,
        last_checked_at=NULL,version=version+1,updated_at=now() WHERE id=${existing.id}`;
      return { domain: await this.get(existing.id), created: true };
    }
    const [row] = await this.sql<DomainRow[]>`INSERT INTO blackshop_domains(hostname,registrar) VALUES(${hostname},${registrar ?? null})
      ON CONFLICT(hostname) DO NOTHING RETURNING *`;
    if (!row) return this.add(raw, registrar);
    return { domain: await this.get(row.id), created: true };
  }

  private async query(hostname: string, type: 'A' | 'AAAA'): Promise<Array<{ type: string; data: string }>> {
    const response = await this.fetcher(`${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    if (!response.ok) throw new Error(`DoH ${type} failed with ${response.status}`);
    const data = await response.json() as { Status?: number; Answer?: Array<{ type: number; data: string }> };
    const names: Record<number, string> = { 1: 'A', 5: 'CNAME', 28: 'AAAA' };
    return (data.Answer ?? []).filter((item) => names[item.type])
      .map((item) => ({ type: names[item.type]!, data: String(item.data).replace(/\.$/, '').toLowerCase() }));
  }

  /** DoH de A e AAAA. Qualquer endereço privado bloqueia; o primeiro endereço público vira o IP fixado do health. */
  private async resolve(hostname: string): Promise<DomainCheck['dns']> {
    try {
      const [a, aaaa] = await Promise.all([this.query(hostname, 'A'), this.query(hostname, 'AAAA')]);
      const seen = new Set<string>();
      const records = [...a, ...aaaa].filter((record) => { const key = `${record.type}:${record.data}`; if (seen.has(key)) return false; seen.add(key); return true; });
      const allowedA = (this.env['VSL_VERCEL_A_RECORDS'] ?? `${VERCEL_APEX_A},216.198.79.1`).split(',').map((item) => item.trim());
      const ok = records.some((record) => (record.type === 'CNAME' && /(^|\.)vercel-dns(-\d+)?\.com$/.test(record.data)) ||
        (record.type === 'A' && allowedA.includes(record.data)));
      const addresses = records.filter((record) => record.type === 'A' || record.type === 'AAAA');
      const privateHit = addresses.some((record) => isPrivateVslAddress(record.data));
      const pinned = privateHit ? undefined : (addresses.find((record) => record.type === 'A') ?? addresses[0])?.data;
      return { ok, code: ok ? 'dns_ok' : records.length ? 'dns_mismatch' : 'dns_missing', records,
        ...(privateHit ? { private: true } : {}), ...(pinned ? { pinned } : {}) };
    } catch {
      return { ok: false, code: 'dns_lookup_failed', records: [] };
    }
  }

  private async health(hostname: string, address: string): Promise<DomainCheck['health']> {
    try {
      const response = await this.healthProbe({ hostname, address, family: isIP(address) === 6 ? 6 : 4, path: VSL_HEALTH_PATH, timeoutMs: this.timeoutMs });
      // Redirect não é seguido: 3xx conta como marcador ausente.
      if (response.status !== 200) return { ok: false, code: 'runtime_marker_missing', status: response.status };
      let body: { service?: unknown } | null = null;
      try { body = JSON.parse(response.body) as { service?: unknown }; } catch { body = null; }
      return body?.service === VSL_RUNTIME_SERVICE ? { ok: true, code: 'runtime_ok', status: 200 } : { ok: false, code: 'runtime_marker_missing', status: 200 };
    } catch (error) {
      const own = error as { code?: string; cause?: { code?: string; message?: string } };
      const text = `${own?.code ?? ''} ${own?.cause?.code ?? ''} ${own?.cause?.message ?? ''}`;
      if (TLS_ERRORS.test(text)) return { ok: false, code: 'ssl_pending' };
      return { ok: false, code: 'unreachable' };
    }
  }

  private async attach(hostname: string, previous: Partial<DomainCheck>): Promise<DomainCheck['vercel']> {
    if (!this.vercel) return this.manualVercel();
    if (previous.vercel?.mode === 'api' && previous.vercel.attached) return previous.vercel;
    try {
      const result = await this.vercel.attach(hostname);
      if (result.status === 'conflict') return { mode: 'api', attached: false, code: 'vercel_domain_in_use',
        message: 'O domínio está ligado a outro projeto/time na Vercel. Remova-o de lá ou valide pelo TXT indicado.' };
      return { mode: 'api', attached: true, code: result.status === 'attached' ? 'vercel_attached' : 'vercel_already_attached',
        verification: result.verification?.length ? result.verification : undefined };
    } catch {
      return { mode: 'api', attached: false, code: 'vercel_api_error', message: 'Falha ao falar com a Vercel; tente "Verificar agora" de novo.' };
    }
  }

  /** "Verificar agora": anexa na Vercel (se configurado), checa DNS e o marcador do runtime. */
  async verify(id: string) {
    const [row] = await this.sql<DomainRow[]>`SELECT * FROM blackshop_domains WHERE id=${id} AND lifecycle_status<>'archived'`;
    if (!row) throw vslError('domain_not_found');
    // Domínio cadastrado antes da reserva (ou que o LandingLab passou a usar depois): nunca anexa na Vercel.
    await this.validateHostname(row.hostname);
    const previous = row.last_check as Partial<DomainCheck>;
    const vercel = await this.attach(row.hostname, previous);
    const dns = await this.resolve(row.hostname);
    // Nunca sonda IP privado; o health conecta no IP validado aqui (pin), sem nova resolução (DNS rebinding).
    const health: DomainCheck['health'] = dns.private ? { ok: false, code: 'dns_private_address' }
      : dns.pinned ? await this.health(row.hostname, dns.pinned) : { ok: false, code: 'unreachable' };
    const dnsStatus = dns.ok || health.ok ? 'verified' : dns.code === 'dns_mismatch' ? 'failed' : 'pending';
    const sslStatus = health.ok ? 'provisioned' : 'pending';
    const healthy = dnsStatus === 'verified' && sslStatus === 'provisioned';
    const check: DomainCheck = { checkedAt: new Date().toISOString(), dns, health, vercel };
    // Domínio ativo não é rebaixado por falha pontual (rotas publicadas continuam servindo).
    if (row.lifecycle_status === 'active' && !healthy) {
      check.degraded = true;
      await this.sql`UPDATE blackshop_domains SET last_check=${this.sql.json(check as never)},last_checked_at=now(),updated_at=now() WHERE id=${id}`;
    } else {
      // suspended/expired nunca voltam sozinhos para active: exige POST /vsl/domains/:id/reactivate.
      const held = row.lifecycle_status === 'suspended' || row.lifecycle_status === 'expired';
      const lifecycle = held ? row.lifecycle_status : healthy ? 'active' : 'registered';
      await this.sql`UPDATE blackshop_domains SET dns_status=${dnsStatus},ssl_status=${sslStatus},lifecycle_status=${lifecycle},
        last_check=${this.sql.json(check as never)},last_checked_at=now(),version=version+1,updated_at=now() WHERE id=${id}`;
    }
    return this.get(id);
  }

  /** Reativa um domínio suspenso/expirado (ação explícita) e roda a verificação: com DNS+health ok volta a `active`. */
  async reactivate(id: string) {
    const [row] = await this.sql`UPDATE blackshop_domains SET lifecycle_status='registered',version=version+1,updated_at=now()
      WHERE id=${id} AND lifecycle_status IN ('suspended','expired') RETURNING id`;
    if (!row) {
      const [exists] = await this.sql`SELECT id FROM blackshop_domains WHERE id=${id} AND lifecycle_status<>'archived'`;
      throw vslError(exists ? 'domain_not_suspended' : 'domain_not_found');
    }
    return this.verify(id);
  }

  /** Remove se não houver rota publicada. Com histórico (releases/rotas) arquiva em vez de apagar. */
  async remove(id: string): Promise<{ id: string; removed: 'deleted' | 'archived' }> {
    const outcome = await this.sql.begin(async (tx) => {
      const [row] = await tx<DomainRow[]>`SELECT * FROM blackshop_domains WHERE id=${id} AND lifecycle_status<>'archived' FOR UPDATE`;
      if (!row) throw vslError('domain_not_found');
      const [published] = await tx`SELECT 1 FROM vsl_public_routes WHERE domain_id=${id} AND publication_status='published' LIMIT 1`;
      const [legacy] = await tx`SELECT 1 FROM vsl_domain_bindings WHERE domain_id=${id} AND publication_status='published' LIMIT 1`;
      if (published || legacy) throw vslError('domain_in_use');
      await tx`UPDATE vsl_projects SET domain_id=NULL,version=version+1,updated_at=now() WHERE domain_id=${id}`;
      const [history] = await tx`SELECT (EXISTS (SELECT 1 FROM vsl_project_releases WHERE domain_id=${id})
        OR EXISTS (SELECT 1 FROM vsl_public_routes WHERE domain_id=${id})
        OR EXISTS (SELECT 1 FROM vsl_domain_bindings WHERE domain_id=${id})) AS used`;
      if (history?.used) {
        await tx`UPDATE blackshop_domains SET lifecycle_status='archived',version=version+1,updated_at=now() WHERE id=${id}`;
        return { hostname: row.hostname, removed: 'archived' as const, attached: Boolean((row.last_check as Partial<DomainCheck>).vercel?.attached) };
      }
      await tx`DELETE FROM blackshop_domains WHERE id=${id}`;
      return { hostname: row.hostname, removed: 'deleted' as const, attached: Boolean((row.last_check as Partial<DomainCheck>).vercel?.attached) };
    });
    if (outcome.attached && this.vercel) await this.vercel.detach(outcome.hostname).catch(() => undefined);
    return { id, removed: outcome.removed };
  }
}


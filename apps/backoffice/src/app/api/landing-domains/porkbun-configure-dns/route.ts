// POST /api/landing-domains/porkbun-configure-dns
//
// Configura DNS wildcard num domínio recém-comprado via Porkbun +
// registra ele no Vercel storefront project (SSL automático).
//
// Fluxo:
//   1. Body: { domainId } — landing_domains.id do domínio pending_dns
//   2. Cria 3 DNS records via Porkbun:
//      - A @ → 76.76.21.21 (Vercel edge)
//      - CNAME * → cname.vercel-dns.com (wildcard subdomínios)
//      - CNAME www → cname.vercel-dns.com
//   3. Adiciona domínio + wildcard *.dominio no Vercel storefront project
//   4. Atualiza landing_domains: role='active', dns_verified_at=now
//   5. Vercel emite SSL Let's Encrypt automaticamente (~1-5 min)
//
// Idempotente: se DNS records já existem, skipa. Se domain já está no Vercel, skipa.

import { landingDomains } from '@blackshop/db/schema-landinglab-core';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { requireVerifiedApiSession } from '@/lib/session';
import { pickAutoRenewState } from '@/lib/porkbun/autorenew-state';

// Projeto que serve as landings (landinglab-storefront). O id fixo antigo
// (prj_VAfj…) era o blackshop-storefront — domínio vinculado lá nunca resolvia
// a landing. Mesma env/fallback de publish-on-domain.
const VERCEL_STOREFRONT_PROJECT_ID =
  process.env['VERCEL_STOREFRONT_PROJECT_ID'] ?? 'landinglab-storefront';
const VERCEL_TEAM_ID = process.env['VERCEL_TEAM_ID'] ?? '';
const VERCEL_A_RECORD = '76.76.21.21';
const VERCEL_CNAME = 'cname.vercel-dns.com';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface ConfigureBody {
  domainId?: string;
}

interface PorkbunSuccess {
  status: 'SUCCESS';
  id?: number;
  records?: Array<{ id: string; name: string; type: string; content: string }>;
}

interface PorkbunError {
  status: 'ERROR';
  message: string;
}

type PorkbunResponse = PorkbunSuccess | PorkbunError;

async function porkbunCall(
  path: string,
  extra: Record<string, unknown>,
  apikey: string,
  secretapikey: string,
): Promise<PorkbunResponse> {
  const res = await fetch(`https://api.porkbun.com/api/json/v3${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey, secretapikey, ...extra }),
    signal: AbortSignal.timeout(20_000),
  });
  return (await res.json()) as PorkbunResponse;
}

export async function POST(req: Request): Promise<Response> {
  // Story 13.10 (AC1) — sessão obrigatória antes de qualquer efeito.
  const sessionErr = await requireVerifiedApiSession(req);
  if (sessionErr) return sessionErr;

  const apikey = process.env['PORKBUN_API_KEY'];
  const secretapikey = process.env['PORKBUN_SECRET_API_KEY'];
  const vercelToken = process.env['VERCEL_TOKEN'];

  if (!apikey || !secretapikey) {
    return NextResponse.json(
      { ok: false, message: 'Porkbun API keys não configuradas' },
      { status: 500 },
    );
  }
  if (!vercelToken) {
    return NextResponse.json(
      { ok: false, message: 'VERCEL_TOKEN não configurada (necessária pra vincular domínio)' },
      { status: 500 },
    );
  }

  let body: ConfigureBody;
  try {
    body = (await req.json()) as ConfigureBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  const domainId = body.domainId?.trim();
  if (!domainId) {
    return NextResponse.json({ ok: false, message: 'domainId obrigatório' }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(landingDomains)
    .where(
      and(eq(landingDomains.id, domainId), eq(landingDomains.registrar, 'porkbun')),
    )
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { ok: false, message: 'Domínio não encontrado' },
      { status: 404 },
    );
  }

  const domain = row.domain;
  const errors: string[] = [];
  const createdRecordIds: number[] = [];

  // 1. Lista records existentes pra idempotência
  const existing = await porkbunCall(`/dns/retrieve/${domain}`, {}, apikey, secretapikey);
  const existingRecords: Array<{ name: string; type: string; content: string }> =
    existing.status === 'SUCCESS' ? existing.records ?? [] : [];

  const hasRecord = (name: string, type: string, content: string): boolean => {
    return existingRecords.some(
      (r) =>
        r.name === (name === '' ? domain : `${name}.${domain}`) &&
        r.type === type &&
        r.content.toLowerCase().includes(content.toLowerCase()),
    );
  };

  // 2. Cria os 3 records (A, CNAME wildcard, CNAME www) se ainda não existem
  const records: Array<{ name: string; type: 'A' | 'CNAME'; content: string }> = [
    { name: '', type: 'A', content: VERCEL_A_RECORD },
    { name: '*', type: 'CNAME', content: VERCEL_CNAME },
    { name: 'www', type: 'CNAME', content: VERCEL_CNAME },
  ];

  for (const rec of records) {
    if (hasRecord(rec.name, rec.type, rec.content)) continue;
    const res = await porkbunCall(
      `/dns/create/${domain}`,
      { name: rec.name, type: rec.type, content: rec.content, ttl: '600' },
      apikey,
      secretapikey,
    );
    if (res.status !== 'SUCCESS') {
      errors.push(`Falha criando ${rec.type} ${rec.name || '@'}: ${(res as PorkbunError).message}`);
    } else if (res.id !== undefined) {
      createdRecordIds.push(res.id);
    }
  }

  if (errors.length > 0) {
    return NextResponse.json(
      { ok: false, message: 'Erros ao configurar DNS', errors },
      { status: 502 },
    );
  }

  // 3. Adiciona domínio + wildcard no Vercel storefront project
  const vercelBase = `https://api.vercel.com/v10/projects/${VERCEL_STOREFRONT_PROJECT_ID}/domains${VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : ''}`;
  const domainsToAdd = [domain, `*.${domain}`];
  const vercelResults: Array<{ domain: string; ok: boolean; message?: string }> = [];

  for (const d of domainsToAdd) {
    try {
      const res = await fetch(vercelBase, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${vercelToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: d }),
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await res.json()) as { error?: { code: string; message: string } };
      if (res.ok) {
        vercelResults.push({ domain: d, ok: true });
      } else if (json.error?.code === 'domain_already_in_use' || json.error?.code === 'domain_taken') {
        // Já existe — OK
        vercelResults.push({ domain: d, ok: true, message: 'já existia' });
      } else {
        vercelResults.push({
          domain: d,
          ok: false,
          message: json.error?.message ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      vercelResults.push({
        domain: d,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const vercelFailed = vercelResults.filter((r) => !r.ok);
  if (vercelFailed.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        message: 'DNS configurado mas falhou em vincular Vercel',
        dnsCreated: createdRecordIds,
        vercelResults,
      },
      { status: 502 },
    );
  }

  // 4. Atualiza landing_domains → role='active'
  const now = new Date();
  await db
    .update(landingDomains)
    .set({
      role: 'active',
      vercelProjectId: VERCEL_STOREFRONT_PROJECT_ID,
      vercelDomainStatus: 'pending', // Vercel vai atualizar via SSL provisioning
      dnsRecords: {
        // Hotfix REL-002: preserva o estado da auto-renovação gravado na compra.
        ...pickAutoRenewState(row.dnsRecords),
        a: VERCEL_A_RECORD,
        cname_wildcard: VERCEL_CNAME,
        cname_www: VERCEL_CNAME,
        configured_at: now.toISOString(),
      },
      dnsVerifiedAt: now,
      updatedAt: now,
    })
    .where(eq(landingDomains.id, domainId));

  return NextResponse.json({
    ok: true,
    domain,
    dnsCreatedIds: createdRecordIds,
    vercelResults,
    message: `DNS configurado + Vercel vinculado. SSL Let's Encrypt será emitido automaticamente em ~1-5 min.`,
    nextStep: 'await_ssl',
  });
}

// GET /api/domains/[id]/status
//
// Task #40 — domain lifecycle: verifica DNS/SSL de um landing_domain via
// Vercel API (getDomainStatus). Se DNS OK e ainda não persistiu, atualiza
// dnsVerifiedAt.
//
// Retorna:
//   { ok, domain, dnsVerified, sslProvisioned, sslExpiresAt, role, expiresAt }
//
// Notas:
// - middleware não roda em /api/*, mesmo padrão do purchase/suggest.
// - LANDINGLAB_VERCEL_TOKEN + LANDINGLAB_VERCEL_PROJECT_ID precisam estar
//   presentes (senão retorna 500 com mensagem de config).

import { landingDomains } from '@blackshop/db/schema-landinglab-core';
import { createVercelClient } from '@blackshop/landinglab-deploy';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { requireVerifiedApiSession } from '@/lib/session';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface Params {
  params: { id: string };
}

export async function GET(req: Request, { params }: Params): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const { id } = params;
  if (!id) {
    return NextResponse.json({ ok: false, message: 'id ausente' }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: landingDomains.id,
      domain: landingDomains.domain,
      role: landingDomains.role,
      expiresAt: landingDomains.expiresAt,
      dnsVerifiedAt: landingDomains.dnsVerifiedAt,
    })
    .from(landingDomains)
    .where(eq(landingDomains.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Domínio não encontrado' }, { status: 404 });
  }

  const token = process.env['LANDINGLAB_VERCEL_TOKEN'];
  const projectId = process.env['LANDINGLAB_VERCEL_PROJECT_ID'];
  if (!token || !projectId) {
    return NextResponse.json(
      {
        ok: false,
        message:
          'LANDINGLAB_VERCEL_TOKEN ou LANDINGLAB_VERCEL_PROJECT_ID não configurados no ambiente.',
      },
      { status: 500 },
    );
  }

  const client = createVercelClient();
  let dnsVerified = false;
  let reason: string | undefined;
  try {
    // getDomainStatus retorna { verified, reason } — no schema Vercel v9,
    // verified=true implica DNS ok + SSL cert emitido (acceptedChallenges > 0).
    const status = await client.getDomainStatus(row.domain, projectId, token);
    dnsVerified = status.verified;
    reason = status.reason;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, message: `Falha ao consultar Vercel: ${message}` },
      { status: 502 },
    );
  }

  // Se DNS OK e ainda não tem dnsVerifiedAt, persiste (usado no cartão de detalhe).
  if (dnsVerified && !row.dnsVerifiedAt) {
    await db
      .update(landingDomains)
      .set({
        dnsVerifiedAt: new Date(),
        vercelDomainStatus: 'valid',
      })
      .where(eq(landingDomains.id, id));
  } else if (!dnsVerified) {
    // Atualiza status intermediário pra o card refletir o motivo do "não pronto".
    await db
      .update(landingDomains)
      .set({
        vercelDomainStatus:
          reason === 'dns_misconfigured' ? 'error' : 'pending',
      })
      .where(eq(landingDomains.id, id));
  }

  return NextResponse.json({
    ok: true,
    domain: row.domain,
    dnsVerified,
    // SSL provisioning is implied by verified=true no schema Vercel; sem
    // acceptedChallenges o Vercel considera unverified.
    sslProvisioned: dnsVerified,
    // Vercel API v9 não retorna expiração do cert Let's Encrypt via /config
    // — cert é auto-rotacionado a cada 90d. Deixamos null pra a UI omitir.
    sslExpiresAt: null,
    role: row.role,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    reason: reason ?? null,
  });
}

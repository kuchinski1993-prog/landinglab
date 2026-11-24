// POST /api/domains/[id]/ssl/re-verify
//
// Task #37 — trigger manual de re-poll SSL para domínios custom já attachados
// ao Vercel. Chama runSslValidator diretamente (NÃO orquestração completa) —
// só verifica se o cert Let's Encrypt já foi provisionado.
//
// Fluxo:
//   1. Busca domain por id
//   2. Valida: registrar='spaceship' AND é custom domain (não subdomain interno)
//   3. Se dnsVerifiedAt já preenchido → 200 idempotente (SSL provisioned)
//   4. Chama runSslValidator({ deploymentType: 'custom_domain', hostname })
//      - provisioned → UPDATE landing_domains SET dnsVerifiedAt=now()
//      - pending     → 202 (SSL ainda pendente, tente em ~5min)
//   5. Erro upstream → 502
//
// Runtime: nodejs (necessário pra HTTP outbound ao Vercel).
// Auth: middleware pattern (não roda em /api/*, igual sibling routes).

import { landingDomains } from '@blackshop/db/schema-landinglab-core';
import { createVercelClient, runSslValidator } from '@blackshop/landinglab-deploy';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { requireVerifiedApiSession } from '@/lib/session';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface Params {
  params: { id: string };
}

// Heurística: ROOT_DOMAIN é o wildcard interno LandingLab (subdomain).
// Custom domain = qualquer coisa fora dele. Mantido em sync com
// packages/landinglab-deploy/src/agents/shared.ts (ROOT_DOMAIN).
const INTERNAL_ROOT_DOMAIN = 'landinglab.app';

function isCustomDomain(domain: string): boolean {
  return !domain.endsWith(`.${INTERNAL_ROOT_DOMAIN}`) && domain !== INTERNAL_ROOT_DOMAIN;
}

export async function POST(req: Request, { params }: Params): Promise<Response> {
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
      registrar: landingDomains.registrar,
      dnsVerifiedAt: landingDomains.dnsVerifiedAt,
      vercelProjectId: landingDomains.vercelProjectId,
    })
    .from(landingDomains)
    .where(eq(landingDomains.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Domínio não encontrado' }, { status: 404 });
  }

  // Validação: só faz sentido pra spaceship (registrado via API + attachado
  // via nossa infra) + custom domain (subdomain interno herda wildcard).
  if (row.registrar !== 'spaceship') {
    return NextResponse.json(
      {
        ok: false,
        message: `Re-verificação SSL disponível apenas para domínios Spaceship. Este é "${row.registrar ?? 'manual'}".`,
      },
      { status: 400 },
    );
  }
  if (!isCustomDomain(row.domain)) {
    return NextResponse.json(
      {
        ok: false,
        message: `"${row.domain}" é subdomínio interno — SSL herdado do wildcard, sem necessidade de re-poll.`,
      },
      { status: 400 },
    );
  }

  // Idempotência: se já verificado, retorna 200 sem re-poll (economia de
  // 5min de polling redundante).
  if (row.dnsVerifiedAt) {
    return NextResponse.json({
      ok: true,
      sslStatus: 'provisioned',
      dnsVerifiedAt: row.dnsVerifiedAt.toISOString(),
      note: 'SSL já provisioned — nenhum poll executado.',
    });
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

  try {
    const vercel = createVercelClient();
    const result = await runSslValidator(
      { deploymentType: 'custom_domain', hostname: row.domain },
      { vercel, vercelProjectId: projectId, vercelToken: token },
    );

    if (result.sslStatus === 'provisioned') {
      // Idempotente: mesma lógica da task 38 — só grava se ainda NULL.
      // (Já checamos row.dnsVerifiedAt acima, mas defensivo contra race.)
      const now = new Date();
      await db
        .update(landingDomains)
        .set({
          dnsVerifiedAt: now,
          vercelDomainStatus: 'valid',
        })
        .where(eq(landingDomains.id, id));

      return NextResponse.json({
        ok: true,
        sslStatus: 'provisioned',
        method: result.method,
        pollAttempts: result.pollAttempts ?? null,
        dnsVerifiedAt: now.toISOString(),
      });
    }

    // sslStatus === 'pending' → SSL ainda não emitido após budget de polls.
    return NextResponse.json(
      {
        ok: true,
        sslStatus: 'pending',
        pollAttempts: result.pollAttempts,
        message: 'SSL ainda pendente após polling. Tente novamente em ~5min.',
        hint: 'Let\'s Encrypt pode levar até 15min pra emitir cert em domínios novos.',
      },
      { status: 202 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, message: `Falha ao re-verificar SSL: ${message}` },
      { status: 500 },
    );
  }
}

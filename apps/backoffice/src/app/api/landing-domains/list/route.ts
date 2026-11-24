// GET /api/landing-domains/list
//
// Retorna todos os domínios ativos do usuário (comprados via Porkbun +
// já com DNS configurado). Usado pelo PublishActions pra decidir se mostra
// "reusar existente" ou apenas "comprar novo".

import { landingDomains } from '@blackshop/db/schema-landinglab-core';
import { desc, or, eq, and } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { requireVerifiedApiSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const sessionErr = await requireVerifiedApiSession(req);
  if (sessionErr) return sessionErr;
  const db = getDb();

  const rows = await db
    .select({
      id: landingDomains.id,
      domain: landingDomains.domain,
      role: landingDomains.role,
      registrar: landingDomains.registrar,
      vercelDomainStatus: landingDomains.vercelDomainStatus,
      dnsVerifiedAt: landingDomains.dnsVerifiedAt,
      createdAt: landingDomains.createdAt,
    })
    .from(landingDomains)
    .where(
      and(
        or(eq(landingDomains.role, 'active'), eq(landingDomains.role, 'pending_dns')),
      ),
    )
    .orderBy(desc(landingDomains.createdAt));

  return NextResponse.json({
    ok: true,
    domains: rows,
    count: rows.length,
  });
}

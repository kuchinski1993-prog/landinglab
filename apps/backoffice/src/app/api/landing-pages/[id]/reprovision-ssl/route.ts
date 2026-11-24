// POST /api/landing-pages/[id]/reprovision-ssl
//
// Reprovisiona SSL do subdomínio publicado. Usado quando publish-core.ts
// addVercelDomain falhou silenciosamente (bug conhecido — Vercel API às
// vezes retorna erro sem lançar exception).
//
// Idempotente: se domain já existe no projeto storefront, retorna ok.

import { NextResponse } from 'next/server';
import { and, eq, desc } from 'drizzle-orm';
import { landingDeployments, landingPages } from '@blackshop/db';

import { reprovisionSsl } from '@/lib/publish-core';
import { getDb } from '@/lib/landing-db';
import { requireAdminRequest } from '@/lib/admin/auth-guard';

const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const db = getDb();

  // Busca deployment mais recente da landing
  const [landing] = await db
    .select({ id: landingPages.id })
    .from(landingPages)
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  if (!landing) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }

  const [deployment] = await db
    .select({ hostname: landingDeployments.hostname })
    .from(landingDeployments)
    .where(eq(landingDeployments.landingPageId, params.id))
    .orderBy(desc(landingDeployments.createdAt))
    .limit(1);

  if (!deployment?.hostname) {
    return NextResponse.json(
      { ok: false, message: 'Nenhum deployment encontrado. Publique a landing primeiro.' },
      { status: 400 },
    );
  }

  const result = await reprovisionSsl(deployment.hostname);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}

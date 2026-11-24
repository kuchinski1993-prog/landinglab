// GET /api/landing-pages/[id]/status
//
// Endpoint leve para polling do EditorPanel enquanto clone/tradução ainda estão
// rodando. Retorna somente os campos que o `deriveCloneLifecycle` precisa pra
// decidir se o editor continua bloqueado. Sem side effects.

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { requireAdminRequest } from '@/lib/admin/auth-guard';
import { getDb } from '@/lib/landing-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const landingId = params.id;
  const db = getDb();

  const [row] = await db
    .select({
      id: landingPages.id,
      generationMode: landingPages.generationMode,
      cloneMetadata: landingPages.cloneMetadata,
      clonedAt: landingPages.clonedAt,
      translationStatus: landingPages.translationStatus,
      status: landingPages.status,
      updatedAt: landingPages.updatedAt,
    })
    .from(landingPages)
    .where(eq(landingPages.id, landingId))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { ok: false, message: 'Landing não encontrada.' },
      { status: 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    generationMode: row.generationMode,
    cloneMetadata: row.cloneMetadata,
    clonedAt: row.clonedAt ? row.clonedAt.toISOString() : null,
    translationStatus: row.translationStatus,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  });
}

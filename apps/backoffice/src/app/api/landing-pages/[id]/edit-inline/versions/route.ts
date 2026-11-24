// GET /api/landing-pages/[id]/edit-inline/versions — Story 26.1
// As 10 últimas versões salvas pelo editor visual (HTML de antes de cada gravação), para "Restaurar versão".
import { NextResponse } from 'next/server';

import { requireAdminRequest } from '@/lib/admin/auth-guard';
import { getLandingPage } from '@/lib/landing-actions';
import { getDb } from '@/lib/landing-db';
import { listInlineVersions } from '@/lib/landing-inline-edit/snapshots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: { id: string };
}

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const landing = await getLandingPage(params.id);
  if (!landing) return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });

  try {
    const versions = await listInlineVersions(getDb(), params.id);
    return NextResponse.json({
      ok: true,
      versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: `Falha ao listar versões: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 500 },
    );
  }
}

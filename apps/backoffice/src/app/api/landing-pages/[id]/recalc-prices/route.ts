// POST /api/landing-pages/:id/recalc-prices
//
// Re-enfileira apply-bundle pra worker reprocessar HTML com preços atualizados
// dos landing_variants. Chamar após editar preços/currency no painel.
//
// Zero payload. Retorna se job foi enfileirado.

import { NextResponse } from 'next/server';

import { enqueueApplyBundle } from '@/lib/enqueue-apply-bundle';
import { requireAdminRequest } from '@/lib/admin/auth-guard';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface Ctx {
  params: { id: string };
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  if (!params.id) {
    return NextResponse.json({ ok: false, error: 'missing landing id' }, { status: 400 });
  }
  const enqueue = await enqueueApplyBundle(params.id, 'recalc-prices');
  return NextResponse.json({
    ok: enqueue.queued,
    queued: enqueue.queued,
    jobId: enqueue.jobId,
    reason: enqueue.reason,
  });
}

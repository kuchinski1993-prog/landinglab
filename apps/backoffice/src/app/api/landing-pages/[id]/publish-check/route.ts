// GET /api/landing-pages/[id]/publish-check
//
// Story 0.6 (AC6): checklist de pré-publicação — o MESMO avaliador que a
// publicação usa (lib/landing-publish-check.ts), para a UI mostrar o que falta
// ANTES de clicar em publicar. Formato: { landingId, ready, items[] } com
// items `{ code, ok, severity, message, fixHint? }`.

import { NextResponse } from 'next/server';

import { evaluatePublishCheck } from '@/lib/landing-publish-check';
import { internalError } from '@/lib/publish-route-error';
import { createDrizzlePublishStore } from '@/lib/publish-store';
import { requireVerifiedApiSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const authErr = await requireVerifiedApiSession(req);
  if (authErr) return authErr;

  const landingId = params.id?.trim();
  if (!landingId) {
    return NextResponse.json({ ok: false, code: 'invalid_input', message: 'id obrigatório' }, { status: 400 });
  }

  try {
    const snapshot = await createDrizzlePublishStore().loadCheckSnapshot(landingId);
    if (!snapshot) {
      return NextResponse.json({ ok: false, code: 'landing_not_found', message: 'Landing não encontrada.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, ...evaluatePublishCheck(snapshot) });
  } catch (err) {
    return internalError('publish-check', err);
  }
}

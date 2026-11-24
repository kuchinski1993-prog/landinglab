// POST /api/landing-domains/publish-on-domain/verify — "Verificar novamente".
//
// Body: { deploymentId }
// Story 0.6 (Decisão 8): reexecuta só Vercel → verificação → finalização para
// uma publicação em provisioning/awaiting_ssl/publish_failed (ou `published`
// antiga sem prova). Idempotente. Mesma guarda da publicação.

import { NextResponse } from 'next/server';

import { verifyLandingPublication } from '@/lib/publish-core';
import { internalError } from '@/lib/publish-route-error';
import { requireVerifiedApiSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  const authErr = await requireVerifiedApiSession(req);
  if (authErr) return authErr;

  let body: { deploymentId?: unknown };
  try {
    body = (await req.json()) as { deploymentId?: unknown };
  } catch {
    return NextResponse.json({ ok: false, code: 'invalid_input', message: 'JSON inválido' }, { status: 400 });
  }
  const deploymentId = typeof body.deploymentId === 'string' ? body.deploymentId.trim() : '';
  if (!deploymentId) {
    return NextResponse.json(
      { ok: false, code: 'invalid_input', message: 'deploymentId obrigatório' },
      { status: 400 },
    );
  }

  try {
    const { httpStatus, ...payload } = await verifyLandingPublication({ deploymentId, source: 'publish-verify' });
    return NextResponse.json(payload, { status: httpStatus });
  } catch (err) {
    return internalError('publish-verify', err);
  }
}

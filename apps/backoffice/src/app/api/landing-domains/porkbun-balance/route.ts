// GET /api/landing-domains/porkbun-balance
//
// Story 13.10 (AC6) — saldo Porkbun para o modal de compra:
//   - source 'live': GET /account/balance (persistido como último conhecido);
//   - source 'last_known': stores.settings.porkbunLastBalance { cents, at };
//   - source 'none': nunca houve leitura.
// A regra bloqueia (ao vivo) × avisa (último conhecido) está em
// lib/porkbun/balance-rule.ts e é aplicada no modal.

import { NextResponse } from 'next/server';

import { requireVerifiedApiSession } from '@/lib/session';
import { resolveBalance } from '@/lib/porkbun/balance';
import { getPorkbunCredentials } from '@/lib/porkbun/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const sessionErr = await requireVerifiedApiSession(req);
  if (sessionErr) return sessionErr;

  const creds = getPorkbunCredentials();
  if (!creds) {
    return NextResponse.json(
      { ok: false, message: 'Porkbun API keys não configuradas' },
      { status: 500 },
    );
  }

  const balance = await resolveBalance(creds);
  return NextResponse.json({ ok: true, balance });
}

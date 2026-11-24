// POST /api/landing-domains/porkbun-check
//
// Story 13.10 (AC4) — checa um domínio DIGITADO livremente pelo operador:
// valida o formato (lowercase, sem esquema/caminho, FQDN) e devolve
// disponibilidade + preço do 1º ano e de renovação (ou o motivo).
//
// Body: { domain: string }

import { NextResponse } from 'next/server';

import { requireVerifiedApiSession } from '@/lib/session';
import { checkDomain, getPorkbunCredentials, PorkbunRateLimitError } from '@/lib/porkbun/client';
import { validateDomainInput } from '@/lib/porkbun/domain-names';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function POST(req: Request): Promise<Response> {
  const sessionErr = await requireVerifiedApiSession(req);
  if (sessionErr) return sessionErr;

  const creds = getPorkbunCredentials();
  if (!creds) {
    return NextResponse.json(
      { ok: false, message: 'Porkbun API keys não configuradas' },
      { status: 500 },
    );
  }

  let body: { domain?: unknown } = {};
  try {
    body = (await req.json()) as { domain?: unknown };
  } catch {
    /* validação abaixo */
  }

  const parsed = validateDomainInput(body.domain);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, message: parsed.reason }, { status: 400 });
  }

  try {
    const quote = await checkDomain(creds, parsed.domain);
    return NextResponse.json({ ok: true, quote });
  } catch (err) {
    if (err instanceof PorkbunRateLimitError) {
      return NextResponse.json(
        {
          ok: false,
          message: `Limite de consultas da Porkbun — tente de novo${err.retryAfterSec ? ` em ${err.retryAfterSec} s` : ' em instantes'}.`,
          retryAfterSec: err.retryAfterSec,
        },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { ok: false, message: 'Falha ao consultar a Porkbun — tente de novo' },
      { status: 502 },
    );
  }
}

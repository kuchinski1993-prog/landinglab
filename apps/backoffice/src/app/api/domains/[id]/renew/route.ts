// POST /api/domains/[id]/renew
//
// Task #40 — domain lifecycle: renova um domínio comprado via Spaceship
// por N anos (default 1, max 10). Se sucesso, atualiza landingDomains.expiresAt
// somando os anos. Se o endpoint Spaceship não estiver disponível na conta,
// retorna 501 com instruções pra renovar via dashboard.
//
// Body: { years?: number }
// Retorna: { ok, newExpiresAt, cost, orderId }

import { landingDomains } from '@blackshop/db/schema-landinglab-core';
import { createSpaceshipClient } from '@blackshop/landinglab-deploy';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { requireVerifiedApiSession } from '@/lib/session';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface Params {
  params: { id: string };
}

interface RenewBody {
  years?: number;
}

export async function POST(req: Request, { params }: Params): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const { id } = params;
  if (!id) {
    return NextResponse.json({ ok: false, message: 'id ausente' }, { status: 400 });
  }

  let body: RenewBody = {};
  try {
    // Body é opcional — se vier vazio, usa default.
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as RenewBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  const years = Math.min(Math.max(body.years ?? 1, 1), 10);

  const db = getDb();
  const rows = await db
    .select({
      id: landingDomains.id,
      domain: landingDomains.domain,
      registrar: landingDomains.registrar,
      expiresAt: landingDomains.expiresAt,
    })
    .from(landingDomains)
    .where(eq(landingDomains.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Domínio não encontrado' }, { status: 404 });
  }

  // Só faz sentido renovar domínio que a gente registrou via Spaceship —
  // manuais (Porkbun, GoDaddy) o usuário renova no dashboard do registrar dele.
  if (row.registrar !== 'spaceship') {
    return NextResponse.json(
      {
        ok: false,
        message: `Domínio registrado via "${row.registrar ?? 'manual'}". Renove pelo dashboard do registrar diretamente.`,
      },
      { status: 400 },
    );
  }

  const client = createSpaceshipClient();
  let orderId: string;
  let cost: number | undefined;
  try {
    const result = await client.renew(row.domain, { years });
    orderId = result.orderId;
    cost = result.cost;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Endpoint indisponível (404 / method not allowed / conta sem permissão)
    // → retorna 501 pra a UI mostrar instrução de renovar via dashboard.
    if (/404|not\s?found|method|501|not\s?implemented/i.test(message)) {
      return NextResponse.json(
        {
          ok: false,
          message:
            'Renovação via API não está disponível para esta conta Spaceship. Renove manualmente pelo dashboard em https://spaceship.com/application/domains',
          fallback: 'manual_dashboard',
        },
        { status: 501 },
      );
    }
    return NextResponse.json(
      { ok: false, message: `Falha ao renovar via Spaceship: ${message}` },
      { status: 502 },
    );
  }

  // Atualiza expiresAt = base + years. Base = expiresAt existente OU agora (se
  // NULL — não deveria acontecer pra domínio spaceship, mas defensivo).
  const base = row.expiresAt ?? new Date();
  const newExpiresAt = new Date(base);
  newExpiresAt.setFullYear(newExpiresAt.getFullYear() + years);

  await db
    .update(landingDomains)
    .set({ expiresAt: newExpiresAt })
    .where(eq(landingDomains.id, id));

  return NextResponse.json({
    ok: true,
    domain: row.domain,
    newExpiresAt: newExpiresAt.toISOString(),
    cost: cost ?? null,
    orderId,
    years,
  });
}

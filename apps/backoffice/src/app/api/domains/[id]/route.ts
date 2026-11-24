// DELETE /api/domains/[id]
//
// Task #40 — domain lifecycle: remove um landing_domain do sistema.
//
// Regras:
//   - Se houver landing_domain_bindings apontando pra este domínio → 409
//     com contagem (UI mostra link pra ver quais landings usam).
//   - Se orphan: (1) remove do Vercel project via removeDomain, (2) NÃO
//     deleta no Spaceship (usuário pagou, o domínio fica na conta dele),
//     (3) apaga a linha do banco.
//
// Retorna: { ok, deletedAt }

import {
  landingDomainBindings,
  landingDomains,
} from '@blackshop/db/schema-landinglab-core';
import { createVercelClient } from '@blackshop/landinglab-deploy';
import { count, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { requireVerifiedApiSession } from '@/lib/session';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface Params {
  params: { id: string };
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const { id } = params;
  if (!id) {
    return NextResponse.json({ ok: false, message: 'id ausente' }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: landingDomains.id,
      domain: landingDomains.domain,
      registrar: landingDomains.registrar,
    })
    .from(landingDomains)
    .where(eq(landingDomains.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Domínio não encontrado' }, { status: 404 });
  }

  // 1. Bloqueia se tem bindings — usuário precisa desvincular landings antes.
  const [bindingCount] = await db
    .select({ n: count() })
    .from(landingDomainBindings)
    .where(eq(landingDomainBindings.domainId, id));
  const bindingsN = bindingCount?.n ?? 0;
  if (bindingsN > 0) {
    return NextResponse.json(
      {
        ok: false,
        code: 'domain_in_use',
        message: `Domínio ainda em uso por ${bindingsN} landing${bindingsN > 1 ? 's' : ''}. Desvincule antes de deletar.`,
        bindingsCount: bindingsN,
        // Link pra tela de detalhe onde os bindings aparecem.
        manageUrl: `/landing-pages/domains/${id}`,
      },
      { status: 409 },
    );
  }

  // 2. Remove do Vercel project (best-effort — se falhar, não bloqueia delete
  // do banco, mas reporta warning). Endpoint DELETE do Vercel é idempotente.
  const token = process.env['LANDINGLAB_VERCEL_TOKEN'];
  const projectId = process.env['LANDINGLAB_VERCEL_PROJECT_ID'];
  let vercelWarning: string | null = null;
  if (token && projectId) {
    try {
      const client = createVercelClient();
      await client.removeDomain(row.domain, projectId, token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 404 no Vercel = domínio nunca foi attachado, tudo bem seguir.
      if (!/404|not\s?found/i.test(message)) {
        vercelWarning = `Falha ao remover do Vercel (será limpo em auditoria): ${message}`;
      }
    }
  }

  // 3. Apaga a linha (Spaceship NÃO é chamado — user pagou pelo domínio,
  // permanece na conta dele até expirar). Cascade limpa bindings se sobrou
  // algum edge case (não deveria depois do check acima).
  await db.delete(landingDomains).where(eq(landingDomains.id, id));

  return NextResponse.json({
    ok: true,
    domain: row.domain,
    deletedAt: new Date().toISOString(),
    vercelWarning,
    note: 'Domínio permanece registrado no Spaceship até expiração — cancele lá se quiser.',
  });
}

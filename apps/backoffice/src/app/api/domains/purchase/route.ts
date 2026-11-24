// POST /api/domains/purchase
//
// Recebe { domain, years?, nickname?, tags?, notes? } e:
//   1. Reserva a linha em landing_domains ANTES de cobrar ("claim"): INSERT … ON CONFLICT (domain)
//      DO NOTHING, role='pending_dns', registrar='spaceship', registrar_domain_id=NULL. O UNIQUE
//      (domain) serializa chamadas simultâneas — quem não ganha o claim NUNCA chama o Spaceship.
//   2. Chama Spaceship register(domain, years=1|N) — COBRA A CARTEIRA.
//   3. Grava o orderId no claim (UPDATE) e devolve id da row + orderId.
//
// Story 18.10d — idempotência (a chave é o domínio normalizado):
//   - claim perdido + linha spaceship com orderId criada há ≤ 15 min → 200 com o resultado da 1ª
//     e `replayed: true` (resposta perdida); sem orderId → 409 domain_purchase_in_progress;
//     qualquer outra linha → 409 domain_already_registered.
//   - ProviderConfigError (nenhum HTTP saiu) → apaga o claim, 500 spaceship_refused.
//   - recusa 4xx do Spaceship → MANTÉM o claim (o retry interno em 5xx pode ter cobrado antes),
//     500 spaceship_refused. Timeout/rede/5xx/sem status → mantém, 502 domain_purchase_uncertain.
//   - cobrou mas o UPDATE falhou → 500 domain_purchase_not_saved com orderId no corpo e no log.
//   Claim preso sai pela rota de apagar domínio (app/api/domains/[id]) depois de conferir no Spaceship.
//
// Após compra, usuário vai em /landing-pages/domains/[id] pra vincular landings.

import { landingDomains } from '@blackshop/db/schema-landinglab-core';
import {
  createSpaceshipClient,
  ProviderConfigError,
  ProviderRetryableError,
} from '@blackshop/landinglab-deploy';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { buildRateLimitResponse, getClientIdentity, rateLimit } from '@/lib/rate-limit';
import { requireVerifiedApiSession } from '@/lib/session';
export const runtime = 'nodejs';
export const maxDuration = 60; // registro pode demorar até 30-40s

interface PurchaseBody {
  domain?: string;
  years?: number;
  nickname?: string;
  tags?: string[];
  notes?: string;
}

/** Janela em que repetir a compra devolve o resultado da 1ª (resposta perdida). */
export const REPLAY_WINDOW_MS = 15 * 60 * 1000;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const CHECK_SPACESHIP_HINT = 'Confira no Spaceship antes de tentar de novo.';

const DOMAIN_REGEX =
  /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export async function POST(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  // Rate limit: 10 compras/dia por usuário — proteção anti-fraude, evita loop
  // acidental cobrando cartão N vezes.
  const rl = await rateLimit(`domain-purchase:${getClientIdentity(req)}`, 10, 24 * 60 * 60 * 1000);
  if (!rl.ok) return buildRateLimitResponse(rl.resetAt);

  let body: PurchaseBody;
  try {
    body = (await req.json()) as PurchaseBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  const domain = body.domain
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (!domain || !DOMAIN_REGEX.test(domain)) {
    return NextResponse.json(
      { ok: false, message: 'Domínio inválido.' },
      { status: 400 },
    );
  }
  const years = Math.min(Math.max(body.years ?? 1, 1), 10);

  const db = getDb();
  const client = createSpaceshipClient();

  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setFullYear(expiresAt.getFullYear() + years);

  // 1. Claim antes de gastar dinheiro — role='pending_dns' porque ainda precisa configurar
  // DNS + SSL (Squad 5 faz isso ao publicar a primeira landing).
  const [claim] = await db
    .insert(landingDomains)
    .values({
      domain,
      nickname: body.nickname?.trim() || null,
      role: 'pending_dns',
      registrar: 'spaceship',
      registrarDomainId: null,
      tags: body.tags ?? [],
      notes: body.notes?.trim() || null,
      expiresAt,
      dnsRecords: {},
    })
    .onConflictDoNothing({ target: landingDomains.domain })
    .returning({ id: landingDomains.id });

  if (!claim) return answerExistingClaim(db, domain);

  // 2. Chama Spaceship (COBRA A CARTEIRA DO USUÁRIO).
  let orderId: string;
  try {
    const result = await client.register(domain, { years });
    orderId = result.orderId;
  } catch (err) {
    const message = `Falha ao comprar via Spaceship: ${err instanceof Error ? err.message : String(err)}`;
    if (err instanceof ProviderConfigError) {
      // Nenhuma chamada HTTP saiu (chave ausente) → nada foi cobrado: libera o domínio.
      try {
        await db.delete(landingDomains).where(eq(landingDomains.id, claim.id));
      } catch (deleteErr) {
        // Claim preso só bloqueia nova tentativa (409 in_progress) — nunca cobra em dobro.
        console.error('[domains/purchase] falha ao liberar o claim', { domain, error: String(deleteErr) });
      }
      return NextResponse.json({ ok: false, code: 'spaceship_refused', message }, { status: 500 });
    }
    const status = err instanceof ProviderRetryableError ? err.httpStatus : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      // 4xx final pode vir depois de uma 1ª tentativa 5xx que cobrou (retry interno do register):
      // o claim fica até o operador conferir.
      console.error('[domains/purchase] Spaceship recusou — claim mantido', { domain, status, error: message });
      return NextResponse.json(
        { ok: false, code: 'spaceship_refused', domain, message: `${message} ${CHECK_SPACESHIP_HINT}` },
        { status: 500 },
      );
    }
    console.error('[domains/purchase] resultado incerto no Spaceship — claim mantido', { domain, status, error: message });
    return NextResponse.json(
      {
        ok: false,
        code: 'domain_purchase_uncertain',
        domain,
        message: `Não sabemos se o Spaceship cobrou a compra de "${domain}". ${CHECK_SPACESHIP_HINT}`,
      },
      { status: 502 },
    );
  }

  // 3. Grava o orderId no claim. Daqui em diante o dinheiro já saiu: o orderId nunca se perde.
  let saved: { id: string } | undefined;
  let saveError: unknown;
  try {
    [saved] = await db
      .update(landingDomains)
      .set({ registrarDomainId: orderId, purchasedAt: new Date(), expiresAt })
      .where(eq(landingDomains.id, claim.id))
      .returning({ id: landingDomains.id });
  } catch (err) {
    saveError = err;
  }

  if (!saved) {
    console.error('[domains/purchase] domain_purchase_not_saved', {
      domain,
      orderId,
      error: saveError === undefined ? 'update sem linha' : String(saveError),
    });
    return NextResponse.json(
      {
        ok: false,
        code: 'domain_purchase_not_saved',
        orderId,
        domain,
        message: `Compra registrada no Spaceship (${orderId}) mas falhou ao gravar no banco. Contate suporte.`,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    domainId: saved.id,
    domain,
    orderId,
    years,
    expiresAt: expiresAt.toISOString(),
  });
}

/** Quem perdeu o claim nunca chama o Spaceship: devolve o resultado da 1ª ou um 409. */
async function answerExistingClaim(db: ReturnType<typeof getDb>, domain: string): Promise<Response> {
  const [row] = await db
    .select({
      id: landingDomains.id,
      registrar: landingDomains.registrar,
      registrarDomainId: landingDomains.registrarDomainId,
      expiresAt: landingDomains.expiresAt,
      createdAt: landingDomains.createdAt,
    })
    .from(landingDomains)
    .where(eq(landingDomains.domain, domain))
    .limit(1);

  // Linha sumiu entre o INSERT e o SELECT (claim liberado) ou compra em andamento/incerta.
  if (!row || (row.registrar === 'spaceship' && !row.registrarDomainId)) {
    return NextResponse.json(
      {
        ok: false,
        code: 'domain_purchase_in_progress',
        message: `A compra de "${domain}" já está em andamento ou sem confirmação. ${CHECK_SPACESHIP_HINT}`,
      },
      { status: 409 },
    );
  }

  const createdAt = new Date(row.createdAt);
  const ageMs = Date.now() - createdAt.getTime();
  if (row.registrar === 'spaceship' && row.registrarDomainId && ageMs >= 0 && ageMs <= REPLAY_WINDOW_MS) {
    const expiresAt = row.expiresAt ? new Date(row.expiresAt) : null;
    const years = expiresAt
      ? Math.max(1, Math.round((expiresAt.getTime() - createdAt.getTime()) / YEAR_MS))
      : 1;
    return NextResponse.json({
      ok: true,
      domainId: row.id,
      domain,
      orderId: row.registrarDomainId,
      years,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      replayed: true,
    });
  }

  return NextResponse.json(
    { ok: false, code: 'domain_already_registered', message: `Domínio "${domain}" já cadastrado.` },
    { status: 409 },
  );
}

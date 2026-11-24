// POST /api/landing-domains/porkbun-purchase
//
// Compra um domínio via Porkbun API. GASTA DINHEIRO REAL do saldo Porkbun.
//
// Story 13.10 (AC1/AC2/AC6/AC7):
//   Body: { domain, priceCents, currency: 'USD', confirmed: true, alias? }
//   1. Sessão obrigatória (401 sem cookie) — antes de qualquer efeito.
//   2. Compra só com confirmação explícita: domínio + preço total confirmado
//      pelo operador (centavos, USD) + `confirmed: true`.
//   3. Cap de US$ 30 e dedup por landing_domains.domain (idempotente).
//   4. Re-consulta /domain/checkDomain: preço diferente do confirmado → 409
//      com o preço novo (tolerância 0: a Porkbun exige `cost` exato).
//   5. POST /domain/create/{domain} com { cost (centavos), agreeToTerms: 'yes',
//      autorenew: 'off' } — auto-renovação NUNCA (valor do cliente ignorado);
//      depois /domain/updateAutoRenew 'off' como garantia.
//   6. Timeout → recuperação via /domain/listAll (filtro `domain`).
//   7. `balance` da resposta → stores.settings.porkbunLastBalance.
//   8. Persiste landing_domains (registrar='porkbun', role='pending_dns').
//      O vínculo com a landing nasce na publicação (landing_domain_bindings).
//
// Hotfix pós-gate (13.10):
//   - SEC-001: sessão validada na API (requireVerifiedApiSession → /auth/me).
//   - REL-001: create com HTTP >= 500 ou sem JSON = INDETERMINADO (mesmo
//     caminho do timeout: listAll). Domínio que a Porkbun diz estar "na sua
//     conta" (re-consulta com inYourAccount ou resposta do create) é
//     RECUPERADO — grava em landing_domains sem cobrar de novo, em vez de 409.
//   - REL-002: estado da auto-renovação persistido em
//     landing_domains.dns_records (chaves AUTORENEW_OFF_KEY/…_CHECKED_AT_KEY,
//     sem migration; configure-dns preserva essas chaves no merge).

import { landingDomains } from '@blackshop/db/schema-landinglab-core';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { requireVerifiedApiSession } from '@/lib/session';
import { saveLastKnownBalance } from '@/lib/porkbun/balance';
import {
  checkDomain,
  createDomain,
  disableAutoRenew,
  formatUsd,
  getPorkbunCredentials,
  isDomainInAccount,
  PorkbunRateLimitError,
  type CreateDomainResult,
} from '@/lib/porkbun/client';
import { validateDomainInput } from '@/lib/porkbun/domain-names';
import { AUTORENEW_CHECKED_AT_KEY, AUTORENEW_OFF_KEY } from '@/lib/porkbun/autorenew-state';

const STORE_ID = 'l0i';
/** Cap de segurança: nada acima de US$ 30 (evita premium/bug de UI). */
const PURCHASE_CAP_CENTS = 3000;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface PurchaseBody {
  domain?: unknown;
  /** Preço total do 1º ano que o operador confirmou (centavos de USD). */
  priceCents?: unknown;
  currency?: unknown;
  confirmed?: unknown;
  alias?: unknown;
  // Qualquer `autorenew` enviado pelo cliente é ignorado de propósito.
}

function fail(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return NextResponse.json({ ok: false, message, ...extra }, { status });
}

const AUTORENEW_WARNING =
  'Não foi possível confirmar a auto-renovação desligada — confira no painel da Porkbun.';

export async function POST(req: Request): Promise<Response> {
  const sessionErr = await requireVerifiedApiSession(req);
  if (sessionErr) return sessionErr;

  const creds = getPorkbunCredentials();
  if (!creds) return fail(500, 'Porkbun API keys não configuradas');

  let body: PurchaseBody;
  try {
    body = (await req.json()) as PurchaseBody;
  } catch {
    return fail(400, 'JSON inválido');
  }

  const parsed = validateDomainInput(body.domain);
  if (!parsed.ok) return fail(400, parsed.reason);
  const domain = parsed.domain;

  if (body.confirmed !== true) {
    return fail(400, 'Compra exige confirmação explícita do preço (confirmed: true)', {
      code: 'confirmation_required',
    });
  }
  const priceCents = Number(body.priceCents);
  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    return fail(400, 'priceCents é obrigatório (preço confirmado, em centavos de USD)', {
      code: 'confirmation_required',
    });
  }
  if (typeof body.currency !== 'string' || body.currency.toUpperCase() !== 'USD') {
    return fail(400, 'Moeda do preço confirmado deve ser USD', { code: 'confirmation_required' });
  }
  if (priceCents > PURCHASE_CAP_CENTS) {
    return fail(
      400,
      `Preço ${formatUsd(priceCents)} acima do limite de ${formatUsd(PURCHASE_CAP_CENTS)} — recusado por segurança`,
    );
  }

  const db = getDb();

  // Dedup: domínio já registrado aqui → sucesso idempotente, sem cobrança.
  const [existingRow] = await db
    .select({ id: landingDomains.id, role: landingDomains.role })
    .from(landingDomains)
    .where(eq(landingDomains.domain, domain))
    .limit(1);
  if (existingRow) {
    return NextResponse.json({
      ok: true,
      domainId: existingRow.id,
      domain,
      costCents: 0,
      message: `Domínio ${domain} já está registrado na sua conta (role=${existingRow.role}). Nenhuma cobrança feita.`,
      nextStep: existingRow.role === 'active' ? 'ready_to_publish' : 'configure_dns',
      alreadyOwned: true,
    });
  }

  // Re-consulta preço/disponibilidade (pode ter mudado desde a sugestão).
  let quote;
  try {
    quote = await checkDomain(creds, domain);
  } catch (err) {
    if (err instanceof PorkbunRateLimitError) {
      return fail(429, 'Limite de consultas da Porkbun — aguarde alguns segundos e tente de novo', {
        retryAfterSec: err.retryAfterSec,
      });
    }
    return fail(502, 'Erro ao re-consultar o domínio na Porkbun — nada foi comprado');
  }
  if (quote.status === 'unknown') {
    return fail(502, `Não foi possível confirmar o preço agora (${quote.reason ?? 'sem resposta'}) — nada foi comprado`);
  }
  // REL-001: já está na nossa conta (ex.: compra anterior que deu timeout/5xx
  // e não foi gravada) → recupera sem chamar o create (sem cobrar de novo).
  const alreadyInAccount = quote.status === 'unavailable' && quote.inYourAccount === true;
  if (!alreadyInAccount && (quote.status !== 'available' || quote.priceCents === null)) {
    return fail(409, `Domínio ${domain} não está disponível: ${quote.reason ?? quote.status}`, {
      code: 'unavailable',
    });
  }
  if (!alreadyInAccount && quote.priceCents !== null && quote.priceCents !== priceCents) {
    return fail(
      409,
      `Preço mudou: você confirmou ${formatUsd(priceCents)}, agora custa ${formatUsd(quote.priceCents)}. Confirme o novo preço.`,
      {
        code: 'price_changed',
        newPriceCents: quote.priceCents,
        renewalCents: quote.renewalCents,
      },
    );
  }

  // Compra (GASTA DINHEIRO REAL).
  let result: CreateDomainResult;
  let recovered = false;
  /** true = nada foi cobrado NESTA tentativa (domínio já estava na conta). */
  let noChargeNow = false;
  const indeterminateFail = (): Response =>
    fail(
      504,
      'A compra não teve resposta conclusiva e o domínio não aparece na conta Porkbun. Confira o saldo/pedidos na Porkbun antes de tentar de novo.',
      { code: 'indeterminate' },
    );
  const recoveredResult: CreateDomainResult = {
    outcome: 'success',
    balanceCents: null,
    chargedCents: null,
    code: null,
    message: null,
  };

  if (alreadyInAccount) {
    result = recoveredResult;
    recovered = true;
    noChargeNow = true;
  } else {
    try {
      result = await createDomain(creds, domain, priceCents);
    } catch {
      // Timeout/rede: a Porkbun PODE ter processado — confere na conta.
      result = { ...recoveredResult, outcome: 'indeterminate' };
    }
    if (result.outcome === 'indeterminate') {
      // Timeout, 5xx ou resposta sem JSON — confere na conta antes de desistir.
      if (!(await isDomainInAccount(creds, domain))) return indeterminateFail();
      result = { ...recoveredResult, balanceCents: result.balanceCents };
      recovered = true;
    }
  }

  if (result.balanceCents !== null) await saveLastKnownBalance(result.balanceCents);

  if (result.outcome === 'insufficient_funds') {
    return fail(
      402,
      `Saldo Porkbun insuficiente para comprar ${domain} (${formatUsd(priceCents)}${result.balanceCents !== null ? `; saldo ${formatUsd(result.balanceCents)}` : ''}). Adicione crédito em porkbun.com/account/credit e tente de novo.`,
      { code: 'insufficient_funds', balanceCents: result.balanceCents },
    );
  }
  if (result.outcome === 'in_your_account') {
    // A Porkbun afirma que o domínio já é nosso → confirma na própria conta
    // (a classificação vem do texto da resposta) e grava sem cobrar de novo.
    if (!(await isDomainInAccount(creds, domain))) return indeterminateFail();
    recovered = true;
    noChargeNow = true;
  } else if (result.outcome === 'already_owned') {
    // Só é "nosso" se estiver na conta; senão é registrado por terceiros.
    if (!(await isDomainInAccount(creds, domain))) {
      return fail(409, `Domínio ${domain} já está registrado por outra pessoa`, { code: 'unavailable' });
    }
    recovered = true;
    noChargeNow = true;
  } else if (result.outcome === 'rejected') {
    return fail(
      502,
      `Porkbun recusou a compra: ${(result.message ?? result.code ?? 'erro desconhecido').slice(0, 300)}`,
      { code: 'rejected' },
    );
  }

  // Garantia extra: auto-renovação desligada (o create não documenta o campo).
  const autoRenewOff = await disableAutoRenew(creds, domain);

  const now = new Date();
  // Custo desta compra; em recuperação "já na conta" o valor pago (se houve)
  // é desconhecido aqui → NULL no banco e 0 na resposta.
  const costCents = noChargeNow ? null : (result.chargedCents ?? priceCents);
  const [inserted] = await db
    .insert(landingDomains)
    .values({
      domain,
      role: 'pending_dns',
      registrar: 'porkbun',
      registrarDomainId: domain,
      // REL-002: estado durável da auto-renovação (lido pelo alerta da 13.13).
      dnsRecords: {
        [AUTORENEW_OFF_KEY]: autoRenewOff,
        [AUTORENEW_CHECKED_AT_KEY]: now.toISOString(),
      },
      storeId: STORE_ID,
      alias: typeof body.alias === 'string' && body.alias.trim() ? body.alias.trim() : null,
      costUsd: costCents === null ? null : (costCents / 100).toFixed(2),
      purchasedAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: landingDomains.domain })
    .returning({ id: landingDomains.id });

  let domainId = inserted?.id;
  if (!domainId) {
    const [row] = await db
      .select({ id: landingDomains.id })
      .from(landingDomains)
      .where(eq(landingDomains.domain, domain))
      .limit(1);
    domainId = row?.id;
  }

  return NextResponse.json({
    ok: true,
    domainId,
    domain,
    costCents: costCents ?? 0,
    renewalCents: quote.renewalCents,
    balanceCents: result.balanceCents,
    autoRenewOff,
    recovered,
    message:
      costCents === null
        ? `Domínio ${domain} já estava na sua conta Porkbun — registrado aqui sem nova cobrança. Próximo: configurar DNS.`
        : `Domínio ${domain} comprado por ${formatUsd(costCents)} (sem auto-renovação). Próximo: configurar DNS.`,
    ...(autoRenewOff ? {} : { warning: AUTORENEW_WARNING }),
    nextStep: 'configure_dns',
  });
}

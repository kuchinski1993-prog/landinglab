// POST /api/landing-domains/publish-on-domain
//
// Publica UMA landing em um subdomínio de um domínio raiz já configurado.
// Body: { landingPageId, domainId, slug, overrideFidelityBlock? }
//
// Story 0.6: invólucro fino do publicador único (lib/publish-core.ts) —
// autenticação, parse, chamada e resposta. A resposta traz o estado
// VERDADEIRO (`status`):
//   200 published      — Vercel aceitou + HTTPS responde; banco published/provisioned.
//   202 awaiting_ssl   — endereço reservado/aceito, SSL ainda não responde.
//   409 awaiting_dns   — DOMAIN_PENDING_DNS (registros DNS em `details`).
//   409 SLUG_IN_USE    — endereço de outra landing; nada dela foi alterado.
//   422 PUBLISH_CHECK_FAILED — checklist de checkout (`details.items`).
//   5xx publish_failed — Vercel fora/lenta/token (code + retryable).

import { NextResponse } from 'next/server';

import { publishLandingCore } from '@/lib/publish-core';
import { internalError } from '@/lib/publish-route-error';
import { requireVerifiedApiSession } from '@/lib/session';

export const runtime = 'nodejs';
// Vercel (2 × 7s) + sondagem HTTPS (2 × 4s + 1s) cabem com folga para o banco.
export const maxDuration = 30;

interface PublishBody {
  landingPageId?: string;
  domainId?: string;
  slug?: string;
  /**
   * Fidelity gate override (2026-09-28). Quando true, permite publish mesmo
   * com clone_metadata.fidelity_blocked=true. Operator precisa revisar
   * clone_metadata.fidelity_findings antes de setar.
   */
  overrideFidelityBlock?: boolean;
}

export async function POST(req: Request): Promise<Response> {
  // Story 13.10 (hotfix SEC-001): sessão validada na API (GET /auth/me), não
  // só a presença do cookie. Único caller é o backoffice autenticado.
  const authErr = await requireVerifiedApiSession(req);
  if (authErr) return authErr;

  let body: PublishBody;
  try {
    body = (await req.json()) as PublishBody;
  } catch {
    return NextResponse.json({ ok: false, code: 'invalid_input', message: 'JSON inválido' }, { status: 400 });
  }

  const landingPageId = body.landingPageId?.trim();
  const domainId = body.domainId?.trim();
  const slug = body.slug?.trim();
  if (!landingPageId || !domainId || !slug) {
    return NextResponse.json(
      { ok: false, code: 'invalid_input', message: 'landingPageId, domainId e slug obrigatórios' },
      { status: 400 },
    );
  }

  try {
    const result = await publishLandingCore({
      landingPageId,
      mode: 'subdomain',
      domainId,
      slug,
      overrideFidelityBlock: body.overrideFidelityBlock === true,
      source: 'publish-on-domain',
    });
    const { httpStatus, ...payload } = result;
    return NextResponse.json(payload, { status: httpStatus });
  } catch (err) {
    return internalError('publish-on-domain', err);
  }
}

// POST /api/landing-domains/porkbun-suggest
//
// Story 13.10 (AC3/AC4/AC5) — sugestões de domínio a partir do produto e do
// idioma/mercado da landing, com disponibilidade e preços reais.
//
// Body: { landingPageId: uuid, tld?: string }
//   - landingPageId: obrigatório — nome do produto/marca + idioma/mercado
//   - tld: filtro opcional (ex.: 'online'); sem filtro = todos os TLDs com preço
//
// Fluxo:
//   1. Sessão (401 sem cookie) → chaves Porkbun
//   2. Contexto de nomes da landing (produto, idioma, marca/URL de origem)
//   3. Raízes parecidas com o produto, SEM o nome da marca de origem
//   4. Preços por TLD (/pricing/get, cache 1 h) → até 25 candidatos mais baratos
//   5. Disponibilidade/preço real num único checkDomain em lote (rate limit)
//   6. Ordena: disponíveis por menor 1º ano; indeterminados/indisponíveis ao final

import { NextResponse } from 'next/server';

import { requireVerifiedApiSession } from '@/lib/session';
import { checkCandidates } from '@/lib/porkbun/check';
import { fetchTldPricing, getPorkbunCredentials, PorkbunRateLimitError } from '@/lib/porkbun/client';
import { buildRoots, pickCandidates, sortQuotes } from '@/lib/porkbun/domain-names';
import { loadLandingNamingContext } from '@/lib/porkbun/landing-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** TLDs devolvidos para o filtro da UI (mais baratos primeiro). */
const TLD_OPTIONS_MAX = 40;

interface SuggestBody {
  landingPageId?: unknown;
  tld?: unknown;
}

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

  let body: SuggestBody = {};
  try {
    body = (await req.json()) as SuggestBody;
  } catch {
    /* sem body → validação abaixo */
  }

  const landingPageId = typeof body.landingPageId === 'string' ? body.landingPageId : '';
  if (!UUID_RE.test(landingPageId)) {
    return NextResponse.json(
      { ok: false, message: 'landingPageId é obrigatório' },
      { status: 400 },
    );
  }
  const tldFilter =
    typeof body.tld === 'string' && body.tld.trim() !== ''
      ? body.tld.trim().replace(/^\./, '').toLowerCase()
      : null;

  const ctx = await loadLandingNamingContext(landingPageId);
  if (!ctx) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }

  let pricing;
  try {
    pricing = await fetchTldPricing();
  } catch (err) {
    const rateLimited = err instanceof PorkbunRateLimitError;
    return NextResponse.json(
      {
        ok: false,
        message: rateLimited
          ? 'Limite de consultas da Porkbun — tente de novo em instantes'
          : 'Não foi possível obter os preços da Porkbun',
      },
      { status: rateLimited ? 429 : 502 },
    );
  }

  const tlds = pricing.slice(0, TLD_OPTIONS_MAX);
  if (!tlds.some((t) => t.tld === 'com')) {
    const com = pricing.find((t) => t.tld === 'com');
    if (com) tlds.push(com);
  }

  if (tldFilter && !pricing.some((t) => t.tld === tldFilter)) {
    return NextResponse.json(
      { ok: false, message: `A Porkbun não vende .${tldFilter}`, tlds },
      { status: 400 },
    );
  }

  const roots = buildRoots(ctx);
  if (roots.length === 0) {
    return NextResponse.json({
      ok: true,
      suggestions: [],
      tlds,
      checkedCount: 0,
      availableCount: 0,
      rateLimited: false,
      retryAfterSec: null,
      message:
        'Sem nome de produto utilizável nesta landing — digite o domínio desejado no campo acima.',
    });
  }

  const candidates = pickCandidates(roots, pricing, { tld: tldFilter });
  const outcome = await checkCandidates(creds, candidates);
  const suggestions = sortQuotes(outcome.quotes);

  return NextResponse.json({
    ok: true,
    suggestions,
    tlds,
    checkedCount: candidates.length,
    availableCount: suggestions.filter((s) => s.status === 'available').length,
    rateLimited: outcome.rateLimited,
    retryAfterSec: outcome.retryAfterSec,
  });
}

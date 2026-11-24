// Proxy same-origin da página /assinatura (Story 15.6, AC11).
// POST /api/ll-subscription-link { orderNumber, email } → POST /stripe-checkout/subscription/link.
// "Não encontrado" é sempre a mesma resposta (sem enumeração); IP do cliente
// repassado para o rate-limit da API.
import { NextResponse } from 'next/server';

import { LOOKUP_NOT_FOUND, normalizeLookupInput, requestContext, requestManageLink } from '@/lib/post-sale-api';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(req: Request): Promise<Response> {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const input = normalizeLookupInput(body);
  if (!input) return NextResponse.json(LOOKUP_NOT_FOUND, { status: 404, headers: NO_STORE });
  let res: Response;
  try {
    res = await requestManageLink(input, requestContext(req.headers));
  } catch {
    return NextResponse.json({ error: 'Temporary error.', code: 'unavailable' }, { status: 502, headers: NO_STORE });
  }
  if (res.status === 404) return NextResponse.json(LOOKUP_NOT_FOUND, { status: 404, headers: NO_STORE });
  if (res.status === 429) {
    return NextResponse.json({ error: 'Too many requests.', code: 'rate_limited' }, { status: 429, headers: NO_STORE });
  }
  if (!res.ok) return NextResponse.json({ error: 'Temporary error.', code: 'unavailable' }, { status: 502, headers: NO_STORE });
  const data = (await res.json().catch(() => ({}))) as { path?: unknown };
  const path = typeof data.path === 'string' && /^\/assinatura\/gerir\?t=[A-Za-z0-9._%-]+$/.test(data.path) ? data.path : null;
  if (!path) return NextResponse.json({ error: 'Temporary error.', code: 'unavailable' }, { status: 502, headers: NO_STORE });
  return NextResponse.json({ path }, { status: 200, headers: NO_STORE });
}

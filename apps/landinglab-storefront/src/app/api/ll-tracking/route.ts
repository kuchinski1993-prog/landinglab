// Proxy same-origin do /rastreio (Story 15.4, AC10).
// POST /api/ll-tracking { orderNumber, email } → POST /landing-orders/lookup.
//
// - "Não encontrado" é sempre a MESMA resposta (pedido inexistente, e-mail
//   errado ou entrada inválida) — sem enumeração.
// - IP do cliente repassado em x-forwarded-for para o rate-limit da API (10/min).
import { NextResponse } from 'next/server';

import { LOOKUP_NOT_FOUND, lookupOrder, normalizeLookupInput, requestContext } from '@/lib/post-sale-api';

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

  const ctx = requestContext(req.headers);
  let res: Response;
  try {
    res = await lookupOrder(input, ctx);
  } catch {
    return NextResponse.json({ error: 'Temporary error.', code: 'unavailable' }, { status: 502, headers: NO_STORE });
  }

  if (res.status === 404) return NextResponse.json(LOOKUP_NOT_FOUND, { status: 404, headers: NO_STORE });
  if (res.status === 429) {
    return NextResponse.json({ error: 'Too many requests.', code: 'rate_limited' }, { status: 429, headers: NO_STORE });
  }
  if (!res.ok) {
    return NextResponse.json({ error: 'Temporary error.', code: 'unavailable' }, { status: 502, headers: NO_STORE });
  }
  const text = await res.text();
  return new NextResponse(text, { status: 200, headers: { 'content-type': 'application/json', ...NO_STORE } });
}

// Link de gestão da assinatura (Story 15.6, AC11): /assinatura/gerir?t=<token>.
// Troca o token assinado (gerado só pela API) por uma sessão do Customer
// Portal na conta Stripe de origem e redireciona (302). Token inválido,
// expirado ou de outra assinatura → /assinatura?e=invalid (mesma resposta).
import { NextResponse } from 'next/server';

import { openSubscriptionPortal, requestContext } from '@/lib/post-sale-api';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const outcome = await openSubscriptionPortal(url.searchParams.get('t'), requestContext(req.headers));
  if (outcome.kind === 'portal') {
    return NextResponse.redirect(outcome.url, { status: 302, headers: { 'cache-control': 'no-store' } });
  }
  const back = new URL('/assinatura', url);
  back.searchParams.set('e', outcome.kind);
  return NextResponse.redirect(back, { status: 302, headers: { 'cache-control': 'no-store' } });
}

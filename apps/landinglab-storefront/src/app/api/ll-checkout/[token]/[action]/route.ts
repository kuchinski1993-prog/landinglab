// Proxy same-origin do checkout Stripe (Story 15.3).
// POST /api/ll-checkout/:token/(intent|shipping|customer|confirm|subscribe) → API.
// `subscribe` (Story 15.6): submit do checkout de assinatura.
import { NextResponse } from 'next/server';

import { callCheckoutApi } from '@/lib/checkout-api';

export const dynamic = 'force-dynamic';

const ACTIONS = new Set(['intent', 'shipping', 'customer', 'confirm', 'subscribe']);
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

export async function POST(
  req: Request,
  { params }: { params: { token: string; action: string } },
): Promise<Response> {
  if (!TOKEN_RE.test(params.token) || !ACTIONS.has(params.action)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const res = await callCheckoutApi(`/stripe-checkout/${params.token}/${params.action}`, {
    method: 'POST',
    body,
    clientIp,
    userAgent: req.headers.get('user-agent'),
  });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

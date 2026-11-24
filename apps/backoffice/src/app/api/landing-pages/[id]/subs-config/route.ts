// GET  /api/landing-pages/:id/subs-config
//        → { enabled, preselected, discountPercent, discountLabel, sellingPlanId }
// PUT  /api/landing-pages/:id/subs-config
//        body: { enabled, preselected, discountPercent, discountLabel, sellingPlanId }
//        → atualiza landing_pages.subs_* + re-enqueue apply-bundle

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { landingPages } from '@blackshop/db/schema-landinglab-core';

import { getDb } from '@/lib/landing-db';
import { enqueueApplyBundle } from '@/lib/enqueue-apply-bundle';
import { requireAdminRequest } from '@/lib/admin/auth-guard';

const STORE_ID = 'l0i';
export const runtime = 'nodejs';
export const maxDuration = 30;

interface Ctx { params: { id: string } }

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const db = getDb();
  const [row] = await db
    .select({
      enabled: landingPages.subsEnabled,
      preselected: landingPages.subsPreselected,
      discountPercent: landingPages.subsDiscountPercent,
      discountLabel: landingPages.subsDiscountLabel,
      sellingPlanId: landingPages.subsSellingPlanId,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  if (!row) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, ...row });
}

export async function PUT(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }); }
  const b = body as {
    enabled?: unknown;
    preselected?: unknown;
    discountPercent?: unknown;
    discountLabel?: unknown;
    sellingPlanId?: unknown;
  };

  const enabled = b.enabled === true;
  const preselected = b.preselected === true;

  // discountPercent: inteiro 0-99
  let discountPercent: number | null = null;
  if (b.discountPercent !== undefined && b.discountPercent !== null) {
    const n = Number(b.discountPercent);
    if (!Number.isInteger(n) || n < 0 || n > 99) {
      return NextResponse.json({ ok: false, error: 'discountPercent deve ser inteiro 0-99' }, { status: 400 });
    }
    discountPercent = n;
  }

  // sellingPlanId: numérico 5-20 dígitos ou GID Shopify
  const sellingPlanIdRaw = typeof b.sellingPlanId === 'string' ? b.sellingPlanId.trim() : '';
  let sellingPlanId: string | null = null;
  if (sellingPlanIdRaw) {
    const numeric = sellingPlanIdRaw.replace(/^gid:\/\/shopify\/SellingPlan\//, '');
    if (!/^\d{5,20}$/.test(numeric)) {
      return NextResponse.json({ ok: false, error: 'sellingPlanId deve ser numérico (5-20 dígitos) ou GID Shopify' }, { status: 400 });
    }
    sellingPlanId = numeric;
  }

  // Proteção operacional: enabled=true requer sellingPlanId
  if (enabled && !sellingPlanId) {
    return NextResponse.json({ ok: false, error: 'sellingPlanId obrigatório quando enabled=true' }, { status: 400 });
  }

  const discountLabelRaw = typeof b.discountLabel === 'string' ? b.discountLabel.trim() : '';
  const discountLabel = discountLabelRaw ? discountLabelRaw.slice(0, 30) : null;

  const db = getDb();
  const result = await db
    .update(landingPages)
    .set({
      subsEnabled: enabled,
      subsPreselected: preselected,
      subsDiscountPercent: discountPercent,
      subsDiscountLabel: discountLabel,
      subsSellingPlanId: sellingPlanId,
      updatedAt: new Date(),
    })
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)))
    .returning({ id: landingPages.id });
  if (result.length === 0) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const enqueue = await enqueueApplyBundle(params.id, 'subs-config');

  return NextResponse.json({
    ok: true,
    enabled,
    preselected,
    discountPercent,
    discountLabel,
    sellingPlanId,
    applyBundleQueued: enqueue.queued,
  });
}

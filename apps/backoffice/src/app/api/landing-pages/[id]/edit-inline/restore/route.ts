// POST /api/landing-pages/[id]/edit-inline/restore — Story 26.1
// Body: { snapshotId }. Volta o html_body para uma versão salva pelo editor visual (só da mesma landing).
// O HTML atual vira snapshot 'inline-edit-restore' antes — dá para desfazer a restauração.
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { landingPages } from '@blackshop/db/schema-landinglab-core';

import { requireAdminRequest } from '@/lib/admin/auth-guard';
import { getLandingPage } from '@/lib/landing-actions';
import { getDb } from '@/lib/landing-db';
import {
  finishInlineSnapshot,
  getInlineSnapshot,
  INLINE_RESTORE_REASON,
  insertInlineSnapshot,
} from '@/lib/landing-inline-edit/snapshots';

export const runtime = 'nodejs';

const STORE_ID = 'l0i';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Ctx {
  params: { id: string };
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  let snapshotId: unknown;
  try {
    snapshotId = ((await req.json()) as { snapshotId?: unknown } | null)?.snapshotId;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }
  if (typeof snapshotId !== 'string' || !UUID_RE.test(snapshotId)) {
    return NextResponse.json({ ok: false, message: 'Versão inválida' }, { status: 400 });
  }

  const landing = await getLandingPage(params.id);
  if (!landing) return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });

  try {
    const db = getDb();
    const snap = await getInlineSnapshot(db, params.id, snapshotId);
    if (!snap) return NextResponse.json({ ok: false, message: 'Versão não encontrada' }, { status: 404 });

    const backupId = await insertInlineSnapshot(db, params.id, landing.htmlBody, INLINE_RESTORE_REASON);
    await db
      .update(landingPages)
      .set({ htmlBody: snap.htmlBody, updatedAt: new Date() })
      .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)));
    if (backupId) await finishInlineSnapshot(db, backupId, snap.htmlBody);
    return NextResponse.json({ ok: true, restoredFrom: snap.id, backupId });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: `Falha ao restaurar: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 500 },
    );
  }
}

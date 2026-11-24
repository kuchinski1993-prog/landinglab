// Story 26.1 — snapshot do html_body antes de cada gravação do editor visual (base do "Restaurar versão").
import crypto from 'node:crypto';

import { and, desc, eq, inArray } from 'drizzle-orm';
import { landingHtmlSnapshots } from '@blackshop/db';

import type { getDb } from '@/lib/landing-db';

type Db = ReturnType<typeof getDb>;

export const INLINE_EDIT_REASON = 'inline-edit';
export const INLINE_RESTORE_REASON = 'inline-edit-restore';
export const INLINE_EDIT_ACTOR = 'inline-editor';
export const VERSIONS_LIMIT = 10;

function digest(html: string): { bytes: number; sha256: string } {
  return {
    bytes: Buffer.byteLength(html, 'utf8'),
    sha256: crypto.createHash('sha256').update(html, 'utf8').digest('hex'),
  };
}

/** Grava o HTML de ANTES da mudança. Devolve o id do snapshot. */
export async function insertInlineSnapshot(
  db: Db,
  landingPageId: string,
  htmlBefore: string,
  reason: string,
  warnings: string[] = [],
): Promise<string | null> {
  const { bytes, sha256 } = digest(htmlBefore);
  const [row] = await db
    .insert(landingHtmlSnapshots)
    .values({ landingPageId, reason, actor: INLINE_EDIT_ACTOR, htmlBody: htmlBefore, bytes, sha256, warnings })
    .returning({ id: landingHtmlSnapshots.id });
  return row?.id ?? null;
}

/** Completa o snapshot com o tamanho/hash do HTML gravado. */
export async function finishInlineSnapshot(db: Db, snapshotId: string, htmlAfter: string): Promise<void> {
  const { bytes, sha256 } = digest(htmlAfter);
  await db
    .update(landingHtmlSnapshots)
    .set({ bytesAfter: bytes, sha256After: sha256 })
    .where(eq(landingHtmlSnapshots.id, snapshotId));
}

export interface InlineVersion {
  id: string;
  reason: string;
  bytes: number;
  createdAt: Date;
}

export async function listInlineVersions(db: Db, landingPageId: string): Promise<InlineVersion[]> {
  return db
    .select({
      id: landingHtmlSnapshots.id,
      reason: landingHtmlSnapshots.reason,
      bytes: landingHtmlSnapshots.bytes,
      createdAt: landingHtmlSnapshots.createdAt,
    })
    .from(landingHtmlSnapshots)
    .where(
      and(
        eq(landingHtmlSnapshots.landingPageId, landingPageId),
        inArray(landingHtmlSnapshots.reason, [INLINE_EDIT_REASON, INLINE_RESTORE_REASON]),
      ),
    )
    .orderBy(desc(landingHtmlSnapshots.createdAt))
    .limit(VERSIONS_LIMIT);
}

export async function getInlineSnapshot(
  db: Db,
  landingPageId: string,
  snapshotId: string,
): Promise<{ id: string; htmlBody: string } | null> {
  const [row] = await db
    .select({ id: landingHtmlSnapshots.id, htmlBody: landingHtmlSnapshots.htmlBody })
    .from(landingHtmlSnapshots)
    .where(
      and(
        eq(landingHtmlSnapshots.id, snapshotId),
        eq(landingHtmlSnapshots.landingPageId, landingPageId),
        inArray(landingHtmlSnapshots.reason, [INLINE_EDIT_REASON, INLINE_RESTORE_REASON]),
      ),
    )
    .limit(1);
  return row ?? null;
}

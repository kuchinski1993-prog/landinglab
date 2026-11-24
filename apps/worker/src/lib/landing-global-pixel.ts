// Story 23.1b · pixel "global" (Configurações → Tracking, `tracking_pixels`) de uma landing sem
// pixel próprio — usado pelo clone (§ resolvePixelConfig) e pelo apply-bundle (§7.15).
// Antes: SEMPRE o pixel da `default` (classe C4 do inventário da 23.1a). Agora: o da loja DONA da
// landing (`landingOwnerStoreId`: o namespace legado `l0i` do LandingLab, a `default` e landing sem
// loja continuam na `default` — mesmo pixel e mesmo rótulo de hoje); landing de outra loja usa o
// pixel dela ou NENHUM (sem fallback entre lojas), com registro no log.
import { landingPages, trackingPixels, type createClient } from '@blackshop/db';
import { landingOwnerStoreId, PLATFORM_DEFAULT_STORE_ID } from '@blackshop/shared/landing-store';
import { and, asc, eq } from 'drizzle-orm';

import { logger } from '../logger.js';

type Db = ReturnType<typeof createClient>['db'];

/** Rótulo gravado no log do apply-bundle (Decisão 3: o valor da `default` não muda). */
export type GlobalPixelSource = 'tracking_pixels_default' | 'tracking_pixels_store';

export interface LandingGlobalPixel {
  pixelId: string;
  /** Loja dona do pixel. */
  storeId: string;
  source: GlobalPixelSource;
}

export interface GlobalPixelOptions {
  /** `true` = o mais antigo (created_at, id) — como o clone; `false` = sem ORDER BY — como o apply-bundle. */
  ordered: boolean;
}

/** Loja da plataforma dona da landing (`landing_pages.store_id` → landingOwnerStoreId). */
export async function landingPixelStoreId(db: Db, landingPageId: string): Promise<string> {
  const [row] = await db
    .select({ storeId: landingPages.storeId })
    .from(landingPages)
    .where(eq(landingPages.id, landingPageId))
    .limit(1);
  return landingOwnerStoreId(row?.storeId ?? null);
}

/** Pixel ativo de `tracking_pixels` da loja dona da landing, ou `null`. */
export async function resolveLandingGlobalPixel(
  db: Db,
  landingPageId: string,
  options: GlobalPixelOptions,
): Promise<LandingGlobalPixel | null> {
  const storeId = await landingPixelStoreId(db, landingPageId);
  const query = db
    .select({ pixelId: trackingPixels.pixelId })
    .from(trackingPixels)
    .where(and(eq(trackingPixels.storeId, storeId), eq(trackingPixels.isActive, true)));
  const [row] = options.ordered
    ? await query.orderBy(asc(trackingPixels.createdAt), asc(trackingPixels.id)).limit(1)
    : await query.limit(1);
  const isDefault = storeId === PLATFORM_DEFAULT_STORE_ID;
  if (!row?.pixelId) {
    if (!isDefault) {
      // Decisão 2 · sem fallback para a default: a landing fica sem pixel global (motivo no log).
      logger.warn({ landingPageId, storeId }, 'landing pixel: loja da landing sem pixel ativo — nenhum pixel injetado (sem fallback)');
    }
    return null;
  }
  return { pixelId: row.pixelId, storeId, source: isDefault ? 'tracking_pixels_default' : 'tracking_pixels_store' };
}

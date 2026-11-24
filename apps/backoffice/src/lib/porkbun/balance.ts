// Story 13.10 (AC6) — saldo Porkbun: ao vivo (/account/balance) ou último
// saldo conhecido persistido em `stores.settings.porkbunLastBalance`
// (jsonb já existente, store 'default' — sem migration nova).
//
// Regra (decisão do orquestrador/@sm):
//   - saldo AO VIVO < preço → BLOQUEIA a compra;
//   - só o ÚLTIMO SALDO CONHECIDO < preço → apenas AVISA (pode estar
//     desatualizado; a Porkbun é a árbitra final).

import { stores } from '@blackshop/db';
import { eq, sql } from 'drizzle-orm';

import type { BalanceView } from './balance-rule';
import { fetchLiveBalance, type PorkbunCredentials } from './client';

import { getDb } from '@/lib/landing-db';

export { evaluateBalance, type BalanceSource, type BalanceVerdict, type BalanceView } from './balance-rule';

export const BALANCE_STORE_ID = 'default';
export const BALANCE_SETTINGS_KEY = 'porkbunLastBalance';

/** Lê o último saldo conhecido de stores.settings. Nunca lança. */
export async function readLastKnownBalance(): Promise<{ cents: number; at: string } | null> {
  try {
    const rows = (await getDb()
      .select({ settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, BALANCE_STORE_ID))
      .limit(1)) as Array<{ settings: unknown }>;
    const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>;
    const raw = settings[BALANCE_SETTINGS_KEY] as { cents?: unknown; at?: unknown } | undefined;
    const cents = Number(raw?.cents);
    if (!raw || !Number.isFinite(cents) || typeof raw.at !== 'string') return null;
    return { cents: Math.round(cents), at: raw.at };
  } catch {
    return null;
  }
}

/**
 * Persiste o último saldo conhecido (merge jsonb — preserva as outras chaves
 * de settings). Nunca lança: falhar aqui não pode desfazer uma compra paga.
 */
export async function saveLastKnownBalance(cents: number, at: Date = new Date()): Promise<boolean> {
  if (!Number.isFinite(cents)) return false;
  try {
    const patch = { [BALANCE_SETTINGS_KEY]: { cents: Math.round(cents), at: at.toISOString() } };
    await getDb()
      .update(stores)
      .set({
        settings: sql`${stores.settings} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: at,
      })
      .where(eq(stores.id, BALANCE_STORE_ID));
    return true;
  } catch (err) {
    console.warn(
      '[porkbun-balance] falha ao persistir último saldo:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Saldo para exibição: ao vivo se possível (e persiste), senão o último conhecido. */
export async function resolveBalance(creds: PorkbunCredentials): Promise<BalanceView> {
  const live = await fetchLiveBalance(creds);
  if (live !== null) {
    const now = new Date();
    await saveLastKnownBalance(live, now);
    return { source: 'live', balanceCents: live, at: now.toISOString() };
  }
  const last = await readLastKnownBalance();
  if (last) return { source: 'last_known', balanceCents: last.cents, at: last.at };
  return { source: 'none', balanceCents: null, at: null };
}

// Story 13.10 — hotfix pós-gate REL-002.
//
// Estado durável da auto-renovação dos domínios comprados via Porkbun.
// Sem migration nova: fica em `landing_domains.dns_records` (jsonb NOT NULL,
// default '{}'), em chaves próprias com prefixo `porkbun_`. `notes` foi
// descartado por ser texto livre editado pelo operador.
//
// Quem grava: porkbun-purchase (após updateAutoRenew 'off').
// Quem preserva: porkbun-configure-dns (merge ao reescrever dns_records).
// Quem lê: alerta de auto-renovação (Story 13.13).

/** `true` = auto-renovação confirmada como desligada; `false` = não confirmada. */
export const AUTORENEW_OFF_KEY = 'porkbun_autorenew_off';
/** ISO timestamp da última tentativa de desligar a auto-renovação. */
export const AUTORENEW_CHECKED_AT_KEY = 'porkbun_autorenew_checked_at';

/** Copia só as chaves de auto-renovação de um dns_records existente. */
export function pickAutoRenewState(dnsRecords: unknown): Record<string, unknown> {
  if (!dnsRecords || typeof dnsRecords !== 'object' || Array.isArray(dnsRecords)) return {};
  const src = dnsRecords as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [AUTORENEW_OFF_KEY, AUTORENEW_CHECKED_AT_KEY]) {
    if (key in src) out[key] = src[key];
  }
  return out;
}

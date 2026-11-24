// Story 17.3b · Domínio da vitrine de uma loja ≠ `default` (`PUT /settings/storefront-domain`).
// A `default` NÃO passa por aqui (segue o fluxo legado, texto livre — caracterização AC1).
// Regra de host: a mesma do checklist da 21.4 (`isValidStoreHost`) — um só critério de "domínio válido".
import { isValidStoreHost } from './store-checklist.js';

export type NormalizedStoreDomain =
  | { ok: true; domain: string | null }
  | { ok: false; reason: 'invalid_domain' };

/**
 * Normaliza o domínio digitado: apara, minúsculas; vazio/`null` → `null` (limpa).
 * Rejeita protocolo, caminho, `?`/`#`, porta, espaço, `_`, `localhost`, IP, host sem ponto,
 * rótulo vazio/> 63 ou começando/terminando em `-`, total > 253. Aceita punycode e `.com.br`.
 */
export function normalizeStoreDomain(raw: unknown): NormalizedStoreDomain {
  if (raw === null || raw === undefined) return { ok: true, domain: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_domain' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, domain: null };
  const domain = trimmed.toLowerCase();
  return isValidStoreHost(domain) ? { ok: true, domain } : { ok: false, reason: 'invalid_domain' };
}

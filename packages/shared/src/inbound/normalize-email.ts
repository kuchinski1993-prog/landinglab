// Normalização de emails para MATCH (não para display/audit).
//
// Regras (padrão de mercado consolidado):
//   - Somente Gmail (gmail.com / googlemail.com) tem semântica de:
//       * dot-insensitivity no local-part (john.doe == johndoe)
//       * plus-addressing (john+tag == john)
//     Outlook, Yahoo, e domínios corporativos tratam dot como significativo.
//     Aplicar essas regras em outros domínios é INCORRETO e pode juntar
//     contas distintas de clientes diferentes.
//
// USO: comparar `normalizeEmailForMatch(from) === normalizeEmailForMatch(order.customer_email)`.
// NUNCA sobrescrever o email original — a canonical form é só chave de comparação.

export function normalizeEmailForMatch(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || at === trimmed.length - 1) return trimmed; // sem @ ou vazio depois

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  // Consolida googlemail.com em gmail.com (mesma conta pro Google).
  const isGmail = domain === 'gmail.com' || domain === 'googlemail.com';
  if (!isGmail) return `${local}@${domain}`;

  // Gmail: strip +tag (tudo depois do primeiro +).
  const plusIdx = local.indexOf('+');
  const noPlus = plusIdx === -1 ? local : local.slice(0, plusIdx);
  // Gmail: strip pontos.
  const noDots = noPlus.replace(/\./g, '');

  return `${noDots}@gmail.com`;
}

/** Compara dois emails aplicando normalização apropriada. */
export function emailsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeEmailForMatch(a);
  const nb = normalizeEmailForMatch(b);
  return na.length > 0 && na === nb;
}

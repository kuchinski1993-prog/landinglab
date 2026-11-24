// Story 21.4 · Itens do checklist cuja TELA de configuração ainda grava na loja `default` (ou em
// credencial global da conta). Para loja ≠ `default` o item NUNCA vira atalho (K2): sai sem link e
// com `blockedBy` — senão o dono sobrescreveria a configuração da AuthenLondon.
//
// Tabela num lugar só: quando a story dona liberar a gravação por loja, basta remover a linha daqui
// (a tela não muda — ela só lê `blockedBy`/`link`). Conferido em `origin/main`:
//   • (brand saiu na 17.4e: /settings/loja/politicas grava na loja ativa desde a 17.4d)
//   • shopify → /settings/loja/shopify grava a conexão Shopify única do cofre (17.3c, decisão 45)
//   • payment → checkout das lojas ≠ default só liga na 17.8 (gateway); sem tela, só enquanto pendente
// Story 17.3b · removidos `pixel` (PUT /settings/tracking grava na loja do request, token em
// storeVaultKey('capi', loja)) e o bloqueio de domínio (tela /settings/loja/endereco por loja, com
// validação e unicidade) — os dois atalhos valem para qualquer loja.
import type { ChecklistItemId } from './store-checklist.js';

export const DEFAULT_STORE_ID = 'default';

export interface ChecklistBlockerRule {
  /** Story que libera o item (exibida como "Aguardando a {blockedBy}"). */
  blockedBy: string;
  /** Por que o atalho não existe — texto mostrado ao dono. */
  reason: string;
  /** `true` = o bloqueio só vale enquanto o item não está pronto (item sem tela própria). */
  pendingOnly?: boolean;
}

export const CHECKLIST_BLOCKERS: Readonly<Partial<Record<ChecklistItemId, ChecklistBlockerRule>>> = {
  payment: {
    blockedBy: '17.8',
    reason: 'O checkout desta loja liga na 17.8 (gateway do Brasil ainda não escolhido).',
    pendingOnly: true,
  },
  shopify: {
    blockedBy: '17.3c',
    reason:
      'A conexão Shopify ainda é uma só para a conta — configurar por aqui trocaria a da loja principal. Depende da decisão 45 (Shopify por loja, 17.3c).',
  },
};

/** Regra de bloqueio do item para a loja, ou `null` (loja `default` nunca é bloqueada). */
export function checklistBlocker(itemId: ChecklistItemId, storeId: string): ChecklistBlockerRule | null {
  if (storeId === DEFAULT_STORE_ID) return null;
  return CHECKLIST_BLOCKERS[itemId] ?? null;
}

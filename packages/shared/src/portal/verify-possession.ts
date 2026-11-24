// Portal · verify-possession (Fase 2).
//
// Prova de posse por email + resource-id na área pública do portal.
// NÃO confunde com verifyIdentity() de inbound (que faz DMARC/DKIM sobre
// e-mails recebidos). Aqui é match direto sobre o resource, executado
// pelo endpoint /storefront/orders/:id ou /storefront/refunds/:id.
//
// Regra dura (anti-enumeração):
//   O caller retorna 404 IDÊNTICO para as três situações:
//     - resource não existe
//     - resource existe em outra store (cross-tenant)
//     - resource existe MAS o email não bate (posse falha)
//   E executa TODAS as queries mesmo no caminho de mismatch — timing
//   normalization: caminho match e mismatch levam o mesmo tempo.
//
// Este módulo é PURO (não faz I/O). Recebe o resultado da query já feita
// pelo caller e responde com { ok, reason }. O caller aplica o veredito.

export type PossessionReason =
  | 'match'
  | 'not_found'
  | 'wrong_store'
  | 'email_mismatch';

export interface PossessionCheck {
  /** True apenas quando o resource existe, é da mesma store, e o email bate. */
  ok: boolean;
  /**
   * Razão estruturada para observability/log — jamais deve virar corpo de
   * resposta pública (isso seria oráculo de enumeração).
   */
  reason: PossessionReason;
}

interface Resource {
  storeId: string;
  customerEmail: string | null;
}

/** Normalização básica de email — mesmo padrão do refunds (trim + lowercase). */
export function normalizePortalEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/**
 * Confere posse a partir da linha do resource já carregada.
 *
 * @param resource   Linha do resource (ou undefined se a query não retornou).
 * @param expectedStoreId  storeId do request (do header X-Store-Id).
 * @param providedEmail    email vindo do request (?email= ou body).
 * @returns PossessionCheck
 */
export function checkPossession(
  resource: Resource | undefined | null,
  expectedStoreId: string,
  providedEmail: string,
): PossessionCheck {
  const email = normalizePortalEmail(providedEmail);

  if (!email) {
    // Sem email não há como provar posse. Trata como not_found para o caller
    // aplicar 404 uniforme.
    return { ok: false, reason: 'not_found' };
  }

  if (!resource) {
    return { ok: false, reason: 'not_found' };
  }

  if (resource.storeId !== expectedStoreId) {
    return { ok: false, reason: 'wrong_store' };
  }

  const resourceEmail = normalizePortalEmail(resource.customerEmail);
  if (resourceEmail !== email) {
    return { ok: false, reason: 'email_mismatch' };
  }

  return { ok: true, reason: 'match' };
}

/**
 * Corpo padrão de 404 público — texto e statusCode SEMPRE iguais entre
 * os quatro casos (not_found / wrong_store / email_mismatch / genuine
 * not found). Use exatamente este corpo em todos os endpoints de detalhe
 * para não vazar existência.
 */
export const PORTAL_NOT_FOUND_BODY = {
  error: 'Not found',
  statusCode: 404,
} as const;

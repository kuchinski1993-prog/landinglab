// Story 18.1b — mensagens da UI para os códigos comuns do catálogo (@blackshop/errors, COMMON_CATALOG)
// e as genéricas por status HTTP, usadas quando o erro não traz um código conhecido.
// Regras de texto (guia docs/ux/guia-padroes-de-tela.md): PT-BR, sem emoji, sem jargão.

import type { ErrorMessageMap } from '../register';

export const COMMON_ERROR_MESSAGES: ErrorMessageMap = {
  validation_failed: { message: 'Alguns dados estão inválidos. Revise os campos e tente de novo.' },
  unauthorized: { message: 'Sua sessão expirou. Entre de novo para continuar.' },
  cross_site_rejected: { message: 'A requisição foi bloqueada por segurança. Recarregue a página e tente de novo.' },
  // Story 18.11: 403/405 genéricos da API ganharam código próprio. Sem botão de repetir.
  forbidden: { message: 'Você não tem permissão para esta ação.', action: 'none' },
  method_not_allowed: { message: 'Esta ação não está disponível aqui. Recarregue a página e tente de novo.', action: 'none' },
  not_found: { message: 'Não encontramos este item. Ele pode ter sido removido.' },
  version_conflict: { message: 'Este item foi alterado em outra aba ou por outra pessoa. Recarregue para ver a versão mais recente.' },
  constraint_conflict: { message: 'A alteração conflita com dados existentes. Recarregue e tente de novo.' },
  rate_limited: { message: 'Muitas tentativas em pouco tempo.' },
  internal_error: { message: 'Algo deu errado do nosso lado. Tente de novo em instantes.' },
  service_unavailable: { message: 'O serviço está indisponível no momento. Tente de novo em instantes.' },
  UPSTREAM_TIMEOUT: { message: 'O serviço externo não respondeu a tempo. Tente de novo em instantes.' },
  UPSTREAM_RATE_LIMITED: { message: 'O serviço externo está recebendo muitas requisições.' },
};

export const NETWORK_ERROR_MESSAGE = 'Sem conexão com o servidor. Verifique a internet e tente de novo.';

/** Mensagem genérica por status HTTP (sem código conhecido). `null` = usa o fallback do chamador. */
export function messageForStatus(status: number): string | null {
  if (status === 401) return COMMON_ERROR_MESSAGES.unauthorized.message;
  if (status === 403) return 'Você não tem permissão para esta ação.';
  if (status === 404) return 'Não encontramos este item.';
  if (status === 409) return 'Este item mudou desde que você abriu a tela. Recarregue para ver a versão mais recente.';
  if (status === 429) return COMMON_ERROR_MESSAGES.rate_limited.message;
  if (status >= 500) return COMMON_ERROR_MESSAGES.internal_error.message;
  return null;
}

// Story 17.2a — mensagens do módulo "plataforma" para a validação da loja ativa (X-Store-Id).
// Sem "Tentar de novo": repetir não adianta — o dono precisa trocar de loja (aviso do shell).

import type { ErrorMessageMap } from '../register';

export const PLATAFORMA_ERROR_MESSAGES: ErrorMessageMap = {
  'plataforma.store_not_found': {
    message: 'A loja selecionada não existe mais. Escolha outra loja no seletor do topo.',
    action: 'none',
  },
  'plataforma.store_inactive': {
    message: 'A loja selecionada está desativada. Escolha outra loja no seletor do topo ou reative a loja em Lojas.',
    action: 'none',
  },
};

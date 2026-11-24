// Story 18.1b — registro das mensagens de erro por módulo do painel.
// Um módulo novo registra o seu mapa uma vez (ex.: no arquivo de mensagens do módulo) e passa
// `{ module: '<id>' }` para `describeError` / `ErrorBanner` quando quiser o texto específico.

import type { ErrorAction, ErrorLinkTarget } from './actions';
import { PLATAFORMA_ERROR_MESSAGES } from './messages/plataforma';
import { VSL_ERROR_MESSAGES } from './messages/vsl';

export interface ErrorMessageEntry {
  /** Frase em português para o dono da loja. */
  message: string;
  /** Ação de recuperação; sem ela vale a tabela de ações por código (`CODE_ACTIONS`) ou o status. */
  action?: ErrorAction;
  /** Destino quando `action` é `link`. */
  link?: ErrorLinkTarget;
  /** Acrescenta a dica de esperar antes de tentar de novo. */
  wait?: boolean;
}

export type ErrorMessageMap = Readonly<Record<string, ErrorMessageEntry>>;

// Story 17.2a · 'plataforma' (loja ativa inexistente/desativada) registrado de fábrica.
const modules = new Map<string, ErrorMessageMap>([
  ['vsl', VSL_ERROR_MESSAGES],
  ['plataforma', PLATAFORMA_ERROR_MESSAGES],
]);

/** Registra (ou substitui) as mensagens de um módulo. Lança se o id ou alguma mensagem vier vazia. */
export function registerErrorMessages(moduleId: string, map: ErrorMessageMap): void {
  if (!moduleId.trim()) throw new Error('[errors] registerErrorMessages: moduleId vazio');
  for (const [code, entry] of Object.entries(map)) {
    if (!code.trim() || typeof entry?.message !== 'string' || !entry.message.trim())
      throw new Error(`[errors] registerErrorMessages('${moduleId}'): mensagem vazia em '${code}'`);
    if (entry.action === 'link' && !entry.link)
      throw new Error(`[errors] registerErrorMessages('${moduleId}'): '${code}' usa action 'link' sem 'link'`);
  }
  modules.set(moduleId, map);
}

export function getModuleMessages(moduleId: string): ErrorMessageMap | undefined {
  return modules.get(moduleId);
}

/** Procura o código nos módulos registrados (ordem de registro), exceto o informado. */
export function findInModules(code: string, except?: string): ErrorMessageEntry | undefined {
  for (const [id, map] of modules) {
    if (id !== except && Object.hasOwn(map, code)) return map[code];
  }
  return undefined;
}

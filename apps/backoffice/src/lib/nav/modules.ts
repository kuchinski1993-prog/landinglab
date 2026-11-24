// Story 20.2 — seam de módulos do menu (ponto único de troca).
//
// Story 19.3a: lê o estado real por loja (registro `@blackshop/shared/modules`
// + tabela `store_modules`) a partir do cache em memória de
// `modules-store.ts`, preenchido pelo `AppShell` via `GET /stores/:id/modules`.
// Continua SÍNCRONA (todos os chamadores são síncronos). Na dúvida → ligado:
// cache vazio/carregando, API fora, outra loja, módulo desconhecido ou sempre
// ligado. O menu (registry.ts), o aviso "Módulo não habilitado para esta loja"
// do shell e a home dependem desta função.

import { isModuleDisabledInCache } from './modules-store';

export const MODULE_DISABLED_MESSAGE = 'Módulo não habilitado para esta loja';

/** O módulo `moduleId` está ligado para a loja `storeId`? */
export function isModuleEnabled(moduleId: string, storeId: string): boolean {
  return !isModuleDisabledInCache(moduleId, storeId);
}

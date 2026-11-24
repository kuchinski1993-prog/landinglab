// Story 19.3a — cache em memória dos módulos da loja ativa (painel).
//
// Preenchido por `GET /stores/:id/modules` quando a loja ativa muda (o
// `AppShell` chama `loadStoreModules`). `isModuleEnabled` (lib/nav/modules.ts)
// lê daqui de forma SÍNCRONA, e quem precisa re-renderizar assina com
// `useStoreModulesSnapshot` (store externa assinada, aplicada como transição).
//
// Fail-open (= comportamento de antes da 19.3a): enquanto não carregou, se a
// API falhar, para outra loja que não a carregada, ou para módulo
// desconhecido / sempre ligado → "ligado". Esconder menu por engano é pior que
// mostrar um item a mais; nada é protegido no servidor por esta regra.
//
// Troca de loja com carregamento em voo: cada pedido tem um número; resposta
// de pedido antigo é descartada (sem vazar o estado de A em B).

import { isKnownModule, moduleMeta } from '@blackshop/shared/modules';
import { startTransition, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export const MODULES_LOAD_FAILED_MESSAGE = 'Não foi possível carregar os módulos desta loja. Mostrando todos.';

export type ModulesStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface StoreModulesSnapshot {
  /** Loja a que o estado se refere (null = nada pedido ainda). */
  storeId: string | null;
  status: ModulesStatus;
  /** Módulos desligados (só com status 'ready'). */
  disabled: ReadonlySet<string>;
  /** Assinatura estável dos desligados (ex.: "tracker,vsl"); '' = nenhum. */
  signature: string;
}

export type StoreModulesFetcher = (storeId: string) => Promise<unknown>;

const EMPTY: ReadonlySet<string> = new Set();
const INITIAL: StoreModulesSnapshot = { storeId: null, status: 'idle', disabled: EMPTY, signature: '' };

let snapshot: StoreModulesSnapshot = INITIAL;
let requestSeq = 0;
const listeners = new Set<() => void>();

function publish(next: StoreModulesSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getStoreModulesSnapshot(): StoreModulesSnapshot {
  return snapshot;
}

export function subscribeStoreModules(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Hook: re-renderiza quando o estado dos módulos muda. Assina a store externa
 * (mesmo contrato de useSyncExternalStore), mas aplica a mudança como
 * transição: a resposta da API pode chegar antes de o shell terminar de
 * hidratar, e uma atualização síncrona forçaria o React a descartar o HTML do
 * servidor (Suspense do shell). Primeira renderização = estado inicial, igual
 * ao do servidor.
 */
export function useStoreModulesSnapshot(): StoreModulesSnapshot {
  const [state, setState] = useState<StoreModulesSnapshot>(INITIAL);
  useEffect(() => {
    const sync = (): void => {
      const next = snapshot;
      startTransition(() => setState(next));
    };
    sync();
    return subscribeStoreModules(sync);
  }, []);
  return state;
}

/** O cache diz que o módulo está DESLIGADO nesta loja? (qualquer dúvida → não) */
export function isModuleDisabledInCache(moduleId: string, storeId: string): boolean {
  const s = snapshot;
  if (s.status !== 'ready' || s.storeId !== storeId) return false;
  if (!isKnownModule(moduleId) || moduleMeta(moduleId)?.alwaysOn) return false;
  return s.disabled.has(moduleId);
}

/**
 * Lê a resposta de `GET /stores/:id/modules`. Item malformado (campo faltando,
 * id desconhecido, `enabled` não booleano) é ignorado → vale o padrão (ligado).
 * Corpo sem a lista ou de outra loja → erro (cai no aviso + "tudo ligado").
 */
export function parseStoreModulesResponse(body: unknown, storeId: string): Set<string> {
  if (body === null || typeof body !== 'object') throw new Error('Resposta de módulos inválida');
  const { storeId: answered, modules } = body as { storeId?: unknown; modules?: unknown };
  if (answered !== undefined && answered !== storeId) throw new Error('Resposta de módulos de outra loja');
  if (!Array.isArray(modules)) throw new Error('Resposta de módulos sem a lista');
  const disabled = new Set<string>();
  for (const item of modules) {
    if (item === null || typeof item !== 'object') continue;
    const { id, enabled } = item as { id?: unknown; enabled?: unknown };
    if (!isKnownModule(id) || typeof enabled !== 'boolean') continue;
    if (moduleMeta(id)?.alwaysOn) continue;
    if (!enabled) disabled.add(id);
  }
  return disabled;
}

export const defaultStoreModulesFetcher: StoreModulesFetcher = (storeId) =>
  apiClient.get<unknown>(`/stores/${encodeURIComponent(storeId)}/modules`);

/**
 * Carrega os módulos da loja. Durante o carregamento de uma loja nova vale
 * "tudo ligado" (o estado da loja anterior não se aplica a ela).
 * Erro → status 'error' (o shell mostra o aviso com "Tentar de novo") e o
 * erro é registrado no console (nunca engolido).
 */
export async function loadStoreModules(
  storeId: string,
  fetcher: StoreModulesFetcher = defaultStoreModulesFetcher,
): Promise<void> {
  const seq = ++requestSeq;
  // Sem publicar "carregando" à toa: o estado de outra loja já não vale para
  // esta (isModuleDisabledInCache confere a loja) e re-render síncrono aqui
  // atrapalharia a hidratação. Só o "Tentar de novo" esconde o aviso de erro.
  if (snapshot.storeId === storeId && snapshot.status === 'error') {
    publish({ storeId, status: 'loading', disabled: EMPTY, signature: '' });
  }
  try {
    const disabled = parseStoreModulesResponse(await fetcher(storeId), storeId);
    if (seq !== requestSeq) return; // loja trocou no meio do caminho
    const signature = [...disabled].sort().join(',');
    publish({ storeId, status: 'ready', disabled, signature });
  } catch (err) {
    if (seq !== requestSeq) return;
    console.warn('[modules] falha ao carregar os módulos da loja; mostrando todos', { storeId, err });
    publish({ storeId, status: 'error', disabled: EMPTY, signature: '' });
  }
}

/** Testes: volta ao estado inicial. */
export function resetStoreModules(): void {
  requestSeq++;
  publish(INITIAL);
}

/** Testes: preenche o cache direto (como se a API tivesse respondido). */
export function primeStoreModules(storeId: string, disabledIds: readonly string[]): void {
  requestSeq++;
  const disabled = new Set(disabledIds.filter((id) => isKnownModule(id) && !moduleMeta(id)?.alwaysOn));
  publish({ storeId, status: 'ready', disabled, signature: [...disabled].sort().join(',') });
}

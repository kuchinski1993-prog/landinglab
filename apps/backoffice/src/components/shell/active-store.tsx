'use client';

// Story 20.2 — loja ativa do painel (cookie `bs:activeStoreId` + `X-Store-Id`).
//
// • Fonte de verdade: o cookie (lib/active-store.ts); o api-client envia
//   `X-Store-Id` em toda chamada.
// • Lista de lojas falhou ou demorou: mostra erro com "Tentar de novo" e
//   MANTÉM a última loja usada — nunca troca de loja sozinho.
// • Trocar de loja grava o cookie, incrementa `storeVersion` (o shell remonta
//   a tela → os dados são buscados de novo com o novo header) e chama
//   `router.refresh()` para os componentes de servidor.
// • Deep link `?loja=<id>`: só vale para loja existente e ativa; senão avisa
//   "Loja não encontrada" e não mexe no cookie.
// • Story 17.2a — a loja ativa (cookie) deixou de existir ou foi desativada: a
//   API passa a recusar (404/409). Com a lista carregada, avisa e oferece
//   "Usar a loja padrão" — a troca só acontece no clique, nunca sozinha.
// • Story 20.5b (PR2) — uma tela com alteração não salva pode registrar uma guarda de troca
//   (`registerSwitchGuard`): a troca pedida pelo usuário fica pendente até a tela confirmar
//   ("Descartar alterações?") e chamar `proceed()`.

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { getActiveStoreId, setActiveStoreId } from '@/lib/active-store';
import { ApiError, apiClient } from '@/lib/api-client';

export interface Store {
  id: string;
  name: string;
  domain: string | null;
  shopifyDomain: string | null;
  isActive: boolean;
}

export interface CreateStorePayload {
  name: string;
  domain?: string | null;
  /** Story 17.4a · região já no cadastro (preset "Brasil"); ausente = definir depois. */
  currency?: string;
  locale?: string;
  timezone?: string;
}

export type StoresStatus = 'loading' | 'ready' | 'error';
export type DeepLinkResult = 'applied' | 'invalid' | 'pending';

export const STORES_LOAD_ERROR = 'Não foi possível carregar as lojas.';
export const STORE_NOT_FOUND_MESSAGE = 'Loja não encontrada';
export const ACTIVE_STORE_UNAVAILABLE_MESSAGE = 'A loja que estava selecionada não está mais disponível.';
export const STORES_TIMEOUT_MS = 10_000;
const LAST_NAME_KEY = 'bs:activeStoreName';
const DEFAULT_STORE_LABEL = 'Loja padrão';

export interface ActiveStoreValue {
  stores: Store[];
  status: StoresStatus;
  activeId: string;
  /** Nome para exibir (lista → último nome salvo → id). */
  activeName: string;
  /** Incrementa a cada troca feita pelo usuário (chave de remontagem da tela). */
  storeVersion: number;
  /** Aviso pontual (ex.: "Loja não encontrada" do deep link, loja ativa indisponível). */
  notice: string | null;
  /** A loja ativa não está na lista carregada (ou está desativada) — Story 17.2a. */
  activeUnavailable: boolean;
  /** Troca para a loja padrão (ação explícita do aviso de loja indisponível). */
  selectDefaultStore: () => void;
  dismissNotice: () => void;
  reload: () => Promise<void>;
  select: (storeId: string) => void;
  createStore: (payload: CreateStorePayload) => Promise<Store>;
  applyDeepLink: (storeId: string) => DeepLinkResult;
  /**
   * Story 20.5b — guarda de troca de loja. A guarda recebe `proceed` (faz a troca) e devolve `true`
   * quando segurou a troca (a tela chama `proceed` depois de confirmar). Devolve a função de remoção.
   */
  registerSwitchGuard?: (guard: StoreSwitchGuard) => () => void;
}

export type StoreSwitchGuard = (proceed: () => void) => boolean;

function readLastName(id: string): string | null {
  try {
    const raw = window.localStorage.getItem(LAST_NAME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown; name?: unknown };
    return parsed.id === id && typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

function saveLastName(id: string, name: string): void {
  try {
    window.localStorage.setItem(LAST_NAME_KEY, JSON.stringify({ id, name }));
  } catch {
    // armazenamento indisponível: só perde o nome em cache
  }
}

/** Estado da loja ativa. `enabled=false` não busca nada (quando há provider acima). */
export function useActiveStoreState({ enabled = true }: { enabled?: boolean } = {}): ActiveStoreValue {
  const router = useRouter();
  const [stores, setStores] = useState<Store[]>([]);
  const [status, setStatus] = useState<StoresStatus>('loading');
  const [activeId, setActiveId] = useState<string>('default');
  const [lastName, setLastName] = useState<string | null>(null);
  const [storeVersion, setStoreVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    setStatus('loading');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STORES_TIMEOUT_MS);
    try {
      const data = await apiClient.get<{ items?: Store[] }>('/stores', { signal: controller.signal });
      if (seq !== loadSeq.current) return;
      setStores(Array.isArray(data?.items) ? data.items : []);
      setStatus('ready');
    } catch (err) {
      if (seq !== loadSeq.current) return;
      // 401: o api-client já redireciona para /login.
      if (err instanceof ApiError && err.status === 401) return;
      // Mantém a lista anterior (se houver) e a loja ativa; só sinaliza o erro.
      setStatus('error');
    } finally {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const id = getActiveStoreId();
    setActiveId(id);
    setLastName(readLastName(id));
    void reload();
  }, [enabled, reload]);

  const activeStore = stores.find((s) => s.id === activeId) ?? null;
  // 'default' nunca é recusada pela API (sem validação), então não entra no aviso.
  const activeUnavailable =
    status === 'ready' && activeId !== 'default' && (!activeStore || !activeStore.isActive);
  const activeName =
    activeStore?.name ?? lastName ?? (activeId === 'default' ? DEFAULT_STORE_LABEL : activeId);

  useEffect(() => {
    if (activeStore) saveLastName(activeStore.id, activeStore.name);
  }, [activeStore]);

  const switchGuardsRef = useRef(new Set<StoreSwitchGuard>());
  const registerSwitchGuard = useCallback((guard: StoreSwitchGuard): (() => void) => {
    switchGuardsRef.current.add(guard);
    return () => {
      switchGuardsRef.current.delete(guard);
    };
  }, []);

  const applySelect = useCallback(
    (storeId: string): void => {
      const target = stores.find((s) => s.id === storeId);
      setActiveStoreId(storeId);
      setActiveId(storeId);
      if (target) {
        setLastName(target.name);
        saveLastName(target.id, target.name);
      }
      setNotice(null);
      setStoreVersion((v) => v + 1);
      router.refresh();
    },
    [router, stores],
  );

  const select = useCallback(
    (storeId: string): void => {
      for (const guard of switchGuardsRef.current) {
        if (guard(() => applySelect(storeId))) return;
      }
      applySelect(storeId);
    },
    [applySelect],
  );

  const createStore = useCallback(
    async (payload: CreateStorePayload): Promise<Store> => {
      const created = await apiClient.post<Store>('/stores', payload);
      setStores((prev) => [...prev, created]);
      setActiveStoreId(created.id);
      setActiveId(created.id);
      setLastName(created.name);
      saveLastName(created.id, created.name);
      setStoreVersion((v) => v + 1);
      router.refresh();
      return created;
    },
    [router],
  );

  const applyDeepLink = useCallback(
    (storeId: string): DeepLinkResult => {
      if (status === 'loading') return 'pending';
      const target = stores.find((s) => s.id === storeId);
      if (status === 'ready' && target && target.isActive) {
        if (storeId !== activeId) select(storeId);
        return 'applied';
      }
      setNotice(
        status === 'error'
          ? 'Não foi possível conferir a loja do link. A loja ativa não mudou.'
          : STORE_NOT_FOUND_MESSAGE,
      );
      return 'invalid';
    },
    [activeId, select, status, stores],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);
  const selectDefaultStore = useCallback(() => select('default'), [select]);
  const shownNotice = notice ?? (activeUnavailable ? ACTIVE_STORE_UNAVAILABLE_MESSAGE : null);

  return useMemo(
    () => ({
      stores,
      status,
      activeId,
      activeName,
      storeVersion,
      notice: shownNotice,
      activeUnavailable,
      selectDefaultStore,
      dismissNotice,
      reload,
      select,
      createStore,
      applyDeepLink,
      registerSwitchGuard,
    }),
    [stores, status, activeId, activeName, storeVersion, shownNotice, activeUnavailable, selectDefaultStore, dismissNotice, reload, select, createStore, applyDeepLink, registerSwitchGuard],
  );
}

const ActiveStoreContext = createContext<ActiveStoreValue | null>(null);

export function ActiveStoreProvider({ children }: { children: ReactNode }): JSX.Element {
  const value = useActiveStoreState();
  return <ActiveStoreContext.Provider value={value}>{children}</ActiveStoreContext.Provider>;
}

/** Loja ativa do shell. Fora do provider devolve `null`. */
export function useActiveStoreContext(): ActiveStoreValue | null {
  return useContext(ActiveStoreContext);
}

/** Usa o provider se existir; senão mantém um estado próprio (ex.: componente isolado em teste). */
export function useActiveStore(): ActiveStoreValue {
  const ctx = useContext(ActiveStoreContext);
  const own = useActiveStoreState({ enabled: ctx === null });
  return ctx ?? own;
}

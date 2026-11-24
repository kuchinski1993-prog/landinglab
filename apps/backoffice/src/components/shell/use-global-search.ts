'use client';

// Story 20.2 (AC9/AC10) — busca do topo.
//  • mínimo de 2 caracteres; debounce;
//  • cancela a requisição anterior (AbortController) e descarta respostas fora
//    de ordem (só a última consulta pode atualizar o estado);
//  • timeout no cliente → estado de erro ("Busca indisponível"), com `retry`.

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_CLIENT_TIMEOUT_MS = 8000;

export interface SearchProductHit {
  id: string;
  title: string;
  status?: string | null;
}
export interface SearchOrderHit {
  id: string;
  orderNumber: string | null;
  customerEmail?: string | null;
}
export interface SearchLandingHit {
  id: string;
  title: string;
  slug?: string | null;
}

export interface SearchResponse {
  query: string;
  products: SearchProductHit[];
  orders: SearchOrderHit[];
  landings: SearchLandingHit[];
  /** Fontes que falharam/estouraram o tempo no servidor (resultado parcial). */
  unavailable?: string[];
}

export type SearchFetcher = (query: string, signal: AbortSignal) => Promise<SearchResponse>;

export const defaultSearchFetcher: SearchFetcher = (query, signal) =>
  apiClient.get<SearchResponse>(`/search?q=${encodeURIComponent(query)}&limit=5`, { signal });

export type SearchStatus = 'idle' | 'loading' | 'success' | 'error';

export interface GlobalSearchState {
  status: SearchStatus;
  data: SearchResponse | null;
  /** Termo da resposta em `data` (pode ser anterior ao digitado enquanto carrega). */
  dataQuery: string;
  retry: () => void;
}

export interface UseGlobalSearchOptions {
  fetcher?: SearchFetcher;
  /** Muda quando a loja ativa muda: descarta resultados da loja anterior e busca de novo. */
  scopeKey?: string;
  debounceMs?: number;
  timeoutMs?: number;
}

export function useGlobalSearch(query: string, options: UseGlobalSearchOptions = {}): GlobalSearchState {
  const {
    fetcher = defaultSearchFetcher,
    debounceMs = SEARCH_DEBOUNCE_MS,
    timeoutMs = SEARCH_CLIENT_TIMEOUT_MS,
    scopeKey = '',
  } = options;
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [dataQuery, setDataQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const seqRef = useRef(0);
  const scopeRef = useRef(scopeKey);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const term = query.trim();

  useEffect(() => {
    const seq = ++seqRef.current;
    if (term.length < SEARCH_MIN_CHARS) {
      setStatus('idle');
      setData(null);
      setDataQuery('');
      return undefined;
    }
    if (scopeRef.current !== scopeKey) {
      // Troca de loja: nada da loja anterior pode continuar na lista.
      scopeRef.current = scopeKey;
      setData(null);
      setDataQuery('');
    }
    setStatus('loading');
    let controller: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const debounce = setTimeout(() => {
      controller = new AbortController();
      const current = controller;
      timeout = setTimeout(() => current.abort(), timeoutMs);
      fetcherRef
        .current(term, current.signal)
        .then((res) => {
          if (seq !== seqRef.current) return;
          setData(res);
          setDataQuery(term);
          setStatus('success');
        })
        .catch(() => {
          // Erro, timeout (abort pelo timer) ou cancelamento: só a consulta atual muda o estado.
          if (seq !== seqRef.current) return;
          setStatus('error');
        })
        .finally(() => clearTimeout(timeout));
    }, debounceMs);
    return () => {
      clearTimeout(debounce);
      clearTimeout(timeout);
      controller?.abort();
    };
  }, [term, attempt, debounceMs, timeoutMs, scopeKey]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { status, data, dataQuery, retry };
}

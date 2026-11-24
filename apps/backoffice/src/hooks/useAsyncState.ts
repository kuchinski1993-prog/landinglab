'use client';

// Story 18.1b — carrega / aborta / tenta de novo, no formato que o `StateBoundary` entende.
// A busca anterior é abortada ao trocar `deps`, ao chamar `retry` e ao desmontar; `AbortError`
// nunca vira estado de erro (é só a tela saindo ou trocando de página).

import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export type AsyncStatus = 'loading' | 'error' | 'empty' | 'ready';

export interface AsyncState<T> {
  status: AsyncStatus;
  data: T | null;
  error: unknown;
  /** Refaz a busca (uma chamada por clique). */
  retry: () => void;
  /**
   * Aborta a busca em andamento (ex.: `onSlow` do StateBoundary). Se ainda estava carregando, o
   * estado vira `error` com `ABORTED_ERROR` (mensagem padrão + "Tentar de novo") — nunca fica preso
   * em `loading`.
   */
  abort: () => void;
  /** Atualiza os dados sem nova busca (ex.: polling da própria tela). */
  setData: (data: T) => void;
}

export interface UseAsyncStateOptions<T> {
  /** Resposta que conta como "vazio" (ex.: lista sem itens). */
  isEmpty?: (data: T) => boolean;
}

/** Erro do estado quando a própria tela aborta a busca (ex.: demora). Sem status: o banner usa o texto padrão. */
export const ABORTED_ERROR_NAME = 'AsyncStateAborted';

function abortedError(): Error {
  return Object.assign(new Error('Busca interrompida pela tela.'), { name: ABORTED_ERROR_NAME });
}

function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

export function useAsyncState<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  options: UseAsyncStateOptions<T> = {},
): AsyncState<T> {
  const [status, setStatus] = useState<AsyncStatus>('loading');
  const statusRef = useRef(status);
  statusRef.current = status;
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const isEmptyRef = useRef(options.isEmpty);
  isEmptyRef.current = options.isEmpty;

  const decide = useCallback((value: T): AsyncStatus => (isEmptyRef.current?.(value) ? 'empty' : 'ready'), []);

  useEffect(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus('loading');
    setError(null);
    loadRef
      .current(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setDataState(value);
        setStatus(decide(value));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbort(err)) return;
        setError(err);
        setStatus('error');
      });
    return () => controller.abort();
    // `deps` é o contrato do chamador (como em useEffect).
  }, [...deps, attempt, decide]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const abort = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    if (statusRef.current !== 'loading') return;
    setError(abortedError());
    setStatus('error');
  }, []);
  const setData = useCallback(
    (value: T) => {
      setDataState(value);
      setStatus(decide(value));
    },
    [decide],
  );

  return { status, data, error, retry, abort, setData };
}

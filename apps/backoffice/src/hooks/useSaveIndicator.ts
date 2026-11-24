'use client';

// Orquestra o ciclo de auto-save com debounce + estados visíveis.
// Consumido pelo componente <SaveIndicator/> (SM-4.7) — separado pra permitir
// testar a máquina de estados isolada da renderização.
//
// Máquina de estados (UX §13.2):
//   idle    → nada pendente
//   saving  → PATCH em andamento
//   saved   → sucesso (mostra "há Xs" ou "há Xm" via lastSavedAt)
//   error   → falha, permite retry
//   offline → sem conexão (não tenta salvar; ao reconectar, força retry)

import { useCallback, useEffect, useRef, useState } from 'react';

import { useDebounce } from './useDebounce';
import { useOnlineStatus } from './useOnlineStatus';

export type SaveIndicatorState = 'idle' | 'saving' | 'saved' | 'error' | 'offline';

export interface UseSaveIndicatorOptions<T> {
  /** Valor observado. Sempre que muda, dispara debounce → auto-save. */
  value: T;
  /** Callback assíncrono que persiste o valor. Rejeita = erro. */
  onSave: (value: T) => Promise<void>;
  /** Debounce em ms. Default 800 (padrão Notion/Linear). */
  delay?: number;
  /** Habilita auto-save. Default true. Se false, hook fica em `idle` sem observar. */
  enabled?: boolean;
}

export interface UseSaveIndicatorResult {
  state: SaveIndicatorState;
  /** Timestamp do último save bem-sucedido (ms epoch). null se nunca salvou. */
  lastSavedAt: number | null;
  /** Erro do último save falho, se houver. */
  error: Error | null;
  /** Força retry (usado pelo botão "Tentar novamente"). */
  retry: () => void;
  /** True se `navigator.onLine === false`. */
  isOffline: boolean;
}

/**
 * Hook orquestrador do save automático. Puro em relação à UI.
 *
 * Comportamento:
 * - Debounce de `delay` ms sobre `value`.
 * - Ignora o primeiro render (evita save do valor inicial).
 * - Se offline, marca estado `offline` e adia o save; reconectar → auto-retry.
 * - `retry()` re-tenta o último valor pendente/errado.
 */
export function useSaveIndicator<T>(options: UseSaveIndicatorOptions<T>): UseSaveIndicatorResult {
  const { value, onSave, delay = 800, enabled = true } = options;

  const debouncedValue = useDebounce(value, delay);
  const isOffline = !useOnlineStatus();

  const [state, setState] = useState<SaveIndicatorState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Ref pra callback estável — evita re-run do effect quando o consumer não
  // memoiza `onSave`.
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  // Ref pro valor mais recente (pra retry() usar o valor atual, não o de closure).
  const lastValueRef = useRef<T>(value);
  useEffect(() => {
    lastValueRef.current = value;
  }, [value]);

  // Skip primeiro render pra não salvar valor inicial.
  const isFirstRun = useRef<boolean>(true);

  // Flag pra permitir cancelamento em unmount / mudanças rápidas.
  const activeRunRef = useRef<number>(0);

  const performSave = useCallback(
    async (val: T): Promise<void> => {
      const runId = ++activeRunRef.current;
      setState('saving');
      setError(null);
      try {
        await onSaveRef.current(val);
        // Se um novo run começou enquanto salvávamos, ignora resultado.
        if (activeRunRef.current !== runId) return;
        setLastSavedAt(Date.now());
        setState('saved');
      } catch (err) {
        if (activeRunRef.current !== runId) return;
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setState('error');
      }
    },
    [],
  );

  // Estado offline tem prioridade — sobrescreve mesmo que estejamos em `saved`.
  useEffect(() => {
    if (isOffline) {
      setState('offline');
    } else {
      // Ao voltar online, se havia pendência ou erro, tenta de novo.
      if (state === 'offline' || state === 'error') {
        void performSave(lastValueRef.current);
      }
    }
  }, [isOffline]);

  // Trigger principal: quando o debouncedValue muda, dispara save.
  useEffect(() => {
    if (!enabled) return;
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    if (isOffline) {
      // Adia — o outro effect vai retomar quando voltar online.
      setState('offline');
      return;
    }
    void performSave(debouncedValue);
  }, [debouncedValue, enabled, isOffline, performSave]);

  // Cleanup: invalida runs pendentes em unmount.
  useEffect(() => {
    return () => {
      activeRunRef.current++;
    };
  }, []);

  const retry = useCallback((): void => {
    if (isOffline) {
      setState('offline');
      return;
    }
    void performSave(lastValueRef.current);
  }, [isOffline, performSave]);

  return {
    state,
    lastSavedAt,
    error,
    retry,
    isOffline,
  };
}

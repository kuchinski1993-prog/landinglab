'use client';

// Story 20.1 — wrapper fino para custom elements `s-*` no React 18.
//
// O React 18 entrega props de custom element como ATRIBUTO (string) e não liga
// eventos custom (`hide`, `show`, `change` do s-select...). Estes hooks fazem o
// que o React 19 faz nativamente: atribuem PROPRIEDADES e registram listeners
// com `addEventListener`, com cleanup na desmontagem. Remover na 20.last.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Atribui `props` como propriedades do elemento a cada render (só as que mudaram).
 * Use valores já normalizados (ex.: `''` para limpar `error`, não `undefined`).
 */
export function useElementProperties<E extends HTMLElement>(
  ref: RefObject<E>,
  props: Record<string, unknown>,
): void {
  useIsomorphicLayoutEffect(() => {
    const el = ref.current as unknown as Record<string, unknown> | null;
    if (!el) return;
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined) continue;
      if (el[key] !== value) el[key] = value;
    }
  });
}

/**
 * Registra `handler` para o evento `type` do elemento. O handler mais recente é
 * sempre usado sem re-registrar o listener; remove na desmontagem.
 */
export function useElementEvent<E extends HTMLElement, Ev extends Event = Event>(
  ref: RefObject<E>,
  type: string,
  handler: ((event: Ev) => void) | undefined,
): void {
  const handlerRef = useRef(handler);
  useIsomorphicLayoutEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const listener = (event: Event): void => handlerRef.current?.(event as Ev);
    el.addEventListener(type, listener);
    return () => el.removeEventListener(type, listener);
  }, [ref, type]);
}

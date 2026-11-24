'use client';

// Story 18.1b — "nenhum carregando eterno": avisa quando `active` passa de `ms` milissegundos.
// `onSlow` é chamado uma vez por período ativo; o timer é limpo ao sair de `active` ou desmontar.

import { useEffect, useRef, useState } from 'react';

export const DEFAULT_SLOW_AFTER_MS = 15_000;

export function useSlowTimer(active: boolean, ms: number = DEFAULT_SLOW_AFTER_MS, onSlow?: () => void): boolean {
  const [slow, setSlow] = useState(false);
  const onSlowRef = useRef(onSlow);
  onSlowRef.current = onSlow;

  useEffect(() => {
    if (!active) {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setSlow(true);
      onSlowRef.current?.();
    }, ms);
    return () => clearTimeout(timer);
  }, [active, ms]);

  return active && slow;
}

'use client';

// Story 21.2a (AC2) — acompanha `prefers-reduced-motion: reduce` em tempo real.

import { useEffect, useState } from 'react';

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

export function useReducedMotion(): boolean {
  // Lido já na 1ª renderização: com "reduzir movimento" o laço nunca chega a começar.
  const [reduced, setReduced] = useState(readReducedMotion);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const sync = (): void => setReduced(mql.matches);
    sync();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', sync);
      return () => mql.removeEventListener('change', sync);
    }
    // Safari < 14
    mql.addListener(sync);
    return () => mql.removeListener(sync);
  }, []);

  return reduced;
}

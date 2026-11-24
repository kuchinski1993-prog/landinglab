'use client';

// Debounce genérico: retorna o valor original apenas após `delay` ms sem mudança.
// Extraído de `landing-pages/page.tsx` (era inline duplicado).
// Usado por SM-4.7 (SaveIndicator, delay=800) e pelo filtro de busca (delay=300).

import { useEffect, useState } from 'react';

export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

'use client';

// Story 21.2a (AC3) — `false` quando a aba está oculta (`document.hidden`).

import { useEffect, useState } from 'react';

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const sync = (): void => setVisible(!document.hidden);
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  return visible;
}

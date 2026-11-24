'use client';

// Reporta se o navegador está online.
// Usa `navigator.onLine` + eventos `online`/`offline` do window.
// SSR-safe: durante o server render, assume online (true) pra evitar mismatch.

import { useEffect, useState } from 'react';

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() => {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine;
  });

  useEffect(() => {
    const handleOnline = (): void => setOnline(true);
    const handleOffline = (): void => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Sincroniza estado logo após mount (caso `navigator.onLine` tenha mudado
    // entre o initial state e o effect).
    setOnline(navigator.onLine);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return online;
}

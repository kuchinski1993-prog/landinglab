'use client';

// Story 22.1b (AC2/AC4, Decisão 6) — depois de entrar: `?callbackUrl=` SÓ se for caminho interno
// (safeCallbackUrl), senão `/`; `push` + `refresh` como o login antigo.

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

import { safeCallbackUrl } from '@/lib/safe-callback-url';

export function readCallbackUrl(): string {
  if (typeof window === 'undefined') return '/';
  return safeCallbackUrl(new URLSearchParams(window.location.search).get('callbackUrl'));
}

export function useAfterLogin(): () => void {
  const router = useRouter();
  return useCallback(() => {
    router.push(readCallbackUrl());
    router.refresh();
  }, [router]);
}

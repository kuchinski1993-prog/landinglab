'use client';

// Story 22.1b (AC10) — usuário da sessão no shell: UMA chamada a `GET /auth/me` no AppShell,
// compartilhada por contexto (menu do usuário, faixa de emergência, /alterar-senha). Falha nunca
// quebra o shell: o menu fica com o texto neutro de antes ("BlackShop"/"BS").
// Um 401 aqui (sessão revogada/expirada) já leva ao /login?callbackUrl=… pelo apiClient.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { apiClient } from '@/lib/api-client';

export interface CurrentUser {
  id: string;
  name: string | null;
  email: string;
  role: string;
}

export interface CurrentUserState {
  status: 'loading' | 'ready' | 'error';
  user: CurrentUser | null;
  /** Sessão aberta pelo acesso de emergência (senha antiga, 22.1a). */
  legacy: boolean;
}

const INITIAL: CurrentUserState = { status: 'loading', user: null, legacy: false };

const CurrentUserContext = createContext<CurrentUserState>(INITIAL);

interface MeResponse {
  authenticated?: unknown;
  user?: { id?: unknown; name?: unknown; email?: unknown; role?: unknown } | null;
  legacy?: unknown;
}

export function parseMe(body: unknown): CurrentUserState {
  const me = (body ?? {}) as MeResponse;
  const u = me.user;
  if (me.authenticated !== true || !u || typeof u.email !== 'string' || typeof u.id !== 'string') {
    return { status: 'error', user: null, legacy: false };
  }
  return {
    status: 'ready',
    user: {
      id: u.id,
      email: u.email,
      name: typeof u.name === 'string' && u.name.trim() ? u.name.trim() : null,
      role: typeof u.role === 'string' ? u.role : 'member',
    },
    legacy: me.legacy === true,
  };
}

export function CurrentUserProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<CurrentUserState>(INITIAL);
  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .get<unknown>('/auth/me', { signal: controller.signal })
      .then((body) => {
        if (!controller.signal.aborted) setState(parseMe(body));
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error', user: null, legacy: false });
      });
    return () => controller.abort();
  }, []);
  return <CurrentUserContext.Provider value={state}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): CurrentUserState {
  return useContext(CurrentUserContext);
}

/** Nome exibido: o nome, senão a parte do e-mail antes do @. */
export function displayName(user: CurrentUser): string {
  return user.name ?? user.email.split('@')[0] ?? user.email;
}

/** Iniciais do nome (1ª e última palavra); sem nome, as 2 primeiras letras do e-mail. */
export function initialsOf(user: CurrentUser): string {
  if (user.name) {
    const words = user.name.split(/\s+/).filter(Boolean);
    const first = words[0]?.[0] ?? '';
    const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
    const value = `${first}${last}`.toUpperCase();
    if (value) return value;
  }
  return (user.email.split('@')[0] ?? '').slice(0, 2).toUpperCase() || '?';
}

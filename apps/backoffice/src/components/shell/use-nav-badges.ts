'use client';

// Story 20.2 — contadores do menu (mesmas chamadas e regras do layout antigo).
//  • supportUnread (Story 15.5): conversas não lidas em LandingLab → Suporte das landings.
//  • landingAlerts (E2E Stripe): avisos não lidos do LandingLab (pagamento falho,
//    cobrança sem pedido/dupla, limite diário) → Pedidos das landings.
//  • accessRequests (Story 22.1c): pedidos de acesso pendentes → Configurações da conta → Usuários.
//    Só para owner (member ⇒ nenhuma chamada a /admin/users*). Atualiza a cada navegação, ao voltar
//    o foco da aba (no máximo 1 chamada a cada 30 s) e na hora quando a tela de Usuários publica o
//    número novo depois de uma ação (`publishAccessRequestsCount`, sem chamada extra).
// Best-effort: falha só esconde o contador; atualiza a cada navegação.

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiClient } from '@/lib/api-client';
import type { NavBadgeKey } from '@/lib/nav/registry';

export type NavBadges = Record<NavBadgeKey, number>;

export const PENDING_COUNT_PATH = '/admin/users/pending-count';
/** Intervalo mínimo entre chamadas disparadas pelo foco da aba (Decisão 5c). */
export const ACCESS_REQUESTS_FOCUS_MIN_MS = 30_000;
const ACCESS_REQUESTS_EVENT = 'blackshop:access-requests-count';

/** A tela de Usuários avisa o shell do número atual de pendentes (contador e faixa mudam na hora). */
export function publishAccessRequestsCount(count: number): void {
  if (typeof window === 'undefined' || !Number.isFinite(count) || count < 0) return;
  window.dispatchEvent(new CustomEvent<number>(ACCESS_REQUESTS_EVENT, { detail: count }));
}

/** Pedidos de acesso pendentes (Story 22.1c) — 0 e nenhuma chamada quando não é owner. */
export function useAccessRequestsCount(pathname: string, owner: boolean): number {
  const [count, setCount] = useState(0);
  const lastFetchRef = useRef(0);
  const seqRef = useRef(0);

  const fetchCount = useCallback(() => {
    const seq = ++seqRef.current;
    lastFetchRef.current = Date.now();
    apiClient
      .get<{ count?: unknown }>(PENDING_COUNT_PATH)
      .then((res) => {
        if (seq === seqRef.current) setCount(typeof res?.count === 'number' && res.count > 0 ? res.count : 0);
      })
      .catch(() => {
        if (seq === seqRef.current) setCount(0);
      });
  }, []);

  useEffect(() => {
    if (!owner) {
      seqRef.current += 1; // descarta resposta em voo
      setCount(0);
      return;
    }
    fetchCount();
  }, [pathname, owner, fetchCount]);

  useEffect(() => {
    if (!owner || typeof document === 'undefined') return undefined;
    function onVisibility(): void {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastFetchRef.current < ACCESS_REQUESTS_FOCUS_MIN_MS) return;
      fetchCount();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [owner, fetchCount]);

  useEffect(() => {
    if (!owner || typeof window === 'undefined') return undefined;
    function onPublish(event: Event): void {
      const value = (event as CustomEvent<unknown>).detail;
      if (typeof value !== 'number') return;
      seqRef.current += 1; // o número publicado vale mais que uma resposta antiga em voo
      setCount(value);
    }
    window.addEventListener(ACCESS_REQUESTS_EVENT, onPublish);
    return () => window.removeEventListener(ACCESS_REQUESTS_EVENT, onPublish);
  }, [owner]);

  return owner ? count : 0;
}

export interface NavBadgesOptions {
  /** Story 22.1c — usuário da sessão é owner (libera o contador de pedidos de acesso). */
  owner?: boolean;
}

export function useNavBadges(pathname: string, options: NavBadgesOptions = {}): NavBadges {
  const accessRequests = useAccessRequestsCount(pathname, options.owner === true);
  const [supportUnread, setSupportUnread] = useState(0);
  const [landingAlerts, setLandingAlerts] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ unread?: unknown }>('/admin/landing-support/threads?page=1&pageSize=1')
      .then((res) => {
        if (!cancelled) setSupportUnread(typeof res?.unread === 'number' ? res.unread : 0);
      })
      .catch(() => {
        if (!cancelled) setSupportUnread(0);
      });
    apiClient
      .get<{ unreadCount?: unknown }>('/notifications?limit=1&onlyUnread=true&source=landinglab')
      .then((res) => {
        if (!cancelled) setLandingAlerts(typeof res?.unreadCount === 'number' ? res.unreadCount : 0);
      })
      .catch(() => {
        if (!cancelled) setLandingAlerts(0);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return { supportUnread, landingAlerts, accessRequests };
}

/** "99+" acima de 99; `null` quando não há o que mostrar. */
export function formatBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

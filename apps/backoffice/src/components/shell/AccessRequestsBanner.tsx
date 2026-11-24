'use client';

// @ds-migrated — Story 22.1c (Decisão 5b, AC12): faixa informativa no shell quando há pedidos de
// acesso aguardando o owner. Só para owner (o contador já vem 0 para member — use-nav-badges.ts).
// "Dispensar" esconde até o fim da sessão do navegador (`sessionStorage`) e a faixa VOLTA se o
// número de pendentes aumentar. Nunca aparece na própria tela de Usuários.

import Link from 'next/link';
import { useEffect, useState } from 'react';

export const USERS_PATH = '/settings/conta/usuarios';
export const ACCESS_REQUESTS_DISMISS_KEY = 'blackshop.accessRequests.dismissedAt';

export function accessRequestsText(count: number): string {
  return count === 1
    ? 'Você tem 1 pedido de acesso aguardando aprovação.'
    : `Você tem ${count} pedidos de acesso aguardando aprovação.`;
}

function readDismissed(): number | null {
  try {
    const raw = window.sessionStorage.getItem(ACCESS_REQUESTS_DISMISS_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null; // sessionStorage bloqueado: a faixa só fica dispensada enquanto a página está aberta
  }
}

function writeDismissed(count: number): void {
  try {
    window.sessionStorage.setItem(ACCESS_REQUESTS_DISMISS_KEY, String(count));
  } catch {
    // sem sessionStorage: vale o estado em memória
  }
}

export interface AccessRequestsBannerProps {
  /** Pendentes agora (0 para member/sem papel). */
  count: number;
  pathname: string;
}

export function AccessRequestsBanner({ count, pathname }: AccessRequestsBannerProps): JSX.Element | null {
  // `undefined` = ainda não leu o sessionStorage (evita piscar a faixa já dispensada).
  const [dismissedAt, setDismissedAt] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    setDismissedAt(readDismissed());
  }, []);

  // O número caiu (pedido tratado): a referência acompanha para baixo — assim um pedido NOVO
  // (aumento a partir daqui) traz a faixa de volta.
  useEffect(() => {
    if (typeof dismissedAt === 'number' && count < dismissedAt) {
      writeDismissed(count);
      setDismissedAt(count);
    }
  }, [count, dismissedAt]);

  if (count <= 0 || dismissedAt === undefined) return null;
  if (pathname === USERS_PATH || pathname.startsWith(`${USERS_PATH}/`)) return null;
  if (typeof dismissedAt === 'number' && count <= dismissedAt) return null;

  return (
    <div className="ds-shell-notice ds-shell-notice--info" role="status" data-testid="shell-access-requests">
      <span>{accessRequestsText(count)}</span>
      <span className="ds-shell-notice__actions">
        <Link href={`${USERS_PATH}?aba=pendentes`} className="ds-shell-button ds-shell-button--primary">
          Ver pedidos
        </Link>
        <button
          type="button"
          className="ds-shell-button"
          onClick={() => {
            writeDismissed(count);
            setDismissedAt(count);
          }}
        >
          Dispensar
        </button>
      </span>
    </div>
  );
}

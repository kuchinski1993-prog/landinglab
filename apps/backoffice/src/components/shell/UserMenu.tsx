'use client';

// @ds-migrated — Story 20.2 (AC12): menu do usuário no topo ("Configurações da conta" e "Sair").
// Story 21.6: item "Assistente de negócios" só quando GET /assistant/status diz que está ligado
// (1 chamada ao montar; falha/404 = item escondido, nunca erro na tela).
// Story 22.1b (AC10): iniciais e nome REAIS (GET /auth/me, current-user.tsx; sem nome = parte do
// e-mail antes do @), e-mail no menu aberto e item "Alterar senha". Sem /auth/me = "BlackShop"/"BS".

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';

import { displayName, initialsOf, useCurrentUser } from './current-user';

import { ASSISTANT_PAGE_PATH, ASSISTANT_STATUS_PATH, ASSISTANT_TITLE } from '@/components/assistant/assistant-model';
import { apiClient } from '@/lib/api-client';

export interface UserMenuProps {
  onLogout: () => void;
}

export function UserMenu({ onLogout }: UserMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [assistantEnabled, setAssistantEnabled] = useState(false);
  const { user } = useCurrentUser();
  const name = user ? displayName(user) : 'BlackShop';
  const initials = user ? initialsOf(user) : 'BS';

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .get<{ enabled?: unknown }>(ASSISTANT_STATUS_PATH, { signal: controller.signal })
      .then((status) => setAssistantEnabled(status?.enabled === true))
      .catch(() => setAssistantEnabled(false)); // tolera falha: o item só não aparece
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div
      className="ds-shell-user"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="ds-shell-user__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ds-shell-user__avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="ds-shell-user__name">{name}</span>
      </button>
      {open ? (
        <div id={menuId} className="ds-shell-popover ds-shell-user__menu" role="menu" aria-label="Menu do usuário">
          {user ? (
            <div className="ds-shell-user__identity" role="none" data-testid="user-menu-identity">
              <span className="ds-shell-user__identity-name">{name}</span>
              <span className="ds-shell-user__identity-email">{user.email}</span>
            </div>
          ) : null}
          {assistantEnabled ? (
            <Link href={ASSISTANT_PAGE_PATH} role="menuitem" className="ds-shell-menu-item" onClick={() => setOpen(false)}>
              {ASSISTANT_TITLE}
            </Link>
          ) : null}
          <Link href="/settings/conta" role="menuitem" className="ds-shell-menu-item" onClick={() => setOpen(false)}>
            Configurações da conta
          </Link>
          <Link href="/alterar-senha" role="menuitem" className="ds-shell-menu-item" onClick={() => setOpen(false)}>
            Alterar senha
          </Link>
          <button
            type="button"
            role="menuitem"
            className="ds-shell-menu-item"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            Sair
          </button>
        </div>
      ) : null}
    </div>
  );
}

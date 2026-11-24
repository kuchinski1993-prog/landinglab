'use client';

// Story 20.1 — modal CONTROLADO sobre <s-modal> (React 18).
//
// `open` → showOverlay()/hideOverlay(); o evento `hide` (Esc, X, backdrop,
// botão) chama `onClose`. Também pode ser aberto sem estado por um
// <DsButton commandFor={id} command="--show"> — aí `onOpen` avisa o pai.
// Ao fechar, o foco volta para quem estava focado antes de abrir.

import { useEffect, useId, useRef, type ReactNode } from 'react';

import { DsButton } from './DsButton';
import { useElementEvent } from './use-custom-element';

type ModalElement = HTMLElementTagNameMap['s-modal'];

export interface DsModalAction {
  content: string;
  onAction?: () => void;
  destructive?: boolean;
  loading?: boolean;
  disabled?: boolean;
}

export interface DsModalProps {
  open: boolean;
  onClose: () => void;
  heading: string;
  children: ReactNode;
  /** Abriu por fora do estado (ex.: commandFor). */
  onOpen?: () => void;
  primaryAction?: DsModalAction;
  secondaryActions?: readonly DsModalAction[];
  size?: 'small-100' | 'small' | 'base' | 'large' | 'large-100';
  id?: string;
}

export function DsModal({
  open,
  onClose,
  heading,
  children,
  onOpen,
  primaryAction,
  secondaryActions,
  size,
  id,
}: DsModalProps): JSX.Element {
  const autoId = useId();
  const modalId = id ?? `ds-modal-${autoId.replace(/:/g, '')}`;
  const ref = useRef<ModalElement>(null);
  const shownRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !shownRef.current) {
      const active = document.activeElement;
      returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      shownRef.current = true;
      el.showOverlay?.();
    } else if (!open && shownRef.current) {
      el.hideOverlay?.();
    }
  }, [open]);

  useElementEvent(ref, 'show', () => {
    if (!shownRef.current) {
      const active = document.activeElement;
      returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    shownRef.current = true;
    if (!openRef.current) onOpen?.();
  });

  useElementEvent(ref, 'hide', () => {
    shownRef.current = false;
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target && target.isConnected) {
      const active = document.activeElement;
      if (!active || active === document.body || ref.current?.contains(active)) target.focus();
    }
    if (openRef.current) onClose();
  });

  return (
    <s-modal ref={ref} id={modalId} heading={heading} size={size}>
      {children}
      {primaryAction ? (
        <DsButton
          slot="primary-action"
          variant="primary"
          tone={primaryAction.destructive ? 'critical' : undefined}
          loading={primaryAction.loading}
          disabled={primaryAction.disabled}
          onClick={primaryAction.onAction}
        >
          {primaryAction.content}
        </DsButton>
      ) : null}
      {secondaryActions?.map((action) => (
        <DsButton
          key={action.content}
          slot="secondary-actions"
          variant="secondary"
          tone={action.destructive ? 'critical' : undefined}
          loading={action.loading}
          disabled={action.disabled}
          onClick={action.onAction}
        >
          {action.content}
        </DsButton>
      ))}
    </s-modal>
  );
}

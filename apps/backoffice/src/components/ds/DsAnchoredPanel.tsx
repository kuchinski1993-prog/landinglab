'use client';

// Story 20.15a — painel ancorado num botão (ex.: lista do sino de notificações), no lugar do `Popover` do
// Polaris React. CONTROLADO pela tela: só existe no DOM com `open` (mesma regra do `active` do Popover) e
// pede para fechar (`onClose`) com Esc ou clique fora — os mesmos gatilhos do Popover. Não decide nada
// sozinho: abrir/fechar continua no estado da tela.
// Sem `.ds-screen` no seletor das classes: pode estar no menu do layout (fora do PolarisGate da página).

import { useEffect, useRef, type ReactNode } from 'react';

export interface DsAnchoredPanelProps {
  open: boolean;
  onClose: () => void;
  /** Botão que abre o painel (a tela controla `aria-expanded`). */
  activator: ReactNode;
  /** Nome acessível do painel (role="dialog"). */
  label: string;
  /** Alinhamento do painel em relação ao botão. */
  align?: 'start' | 'end';
  children: ReactNode;
}

export function DsAnchoredPanel({ open, onClose, activator, label, align = 'end', children }: DsAnchoredPanelProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e: MouseEvent): void => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="ds-anchored">
      {activator}
      {open ? (
        <div role="dialog" aria-label={label} className={align === 'start' ? 'ds-anchored__panel ds-anchored__panel--start' : 'ds-anchored__panel'}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

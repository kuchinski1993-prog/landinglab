'use client';

// Story 20.10d (PR B, decisão 77) — abas de fila como grupo de botões com contador ("Abertas (3)"), no
// lugar do `QueueTabs` do TrustShield (Polaris React). Cada aba é um `s-press-button` com `pressed`
// controlado pela tela: o componente alterna o próprio estado no clique, então o valor da tela é
// reaplicado logo depois (inclusive quando se clica na aba que já está ativa).

import { useRef } from 'react';

import { useElementEvent, useElementProperties } from './use-custom-element';

export interface DsQueueTab<T extends string> {
  id: T;
  label: string;
  /** Contador exibido como "Rótulo (N)"; sem número, só o rótulo. */
  count?: number;
}

export interface DsQueueTabsProps<T extends string> {
  tabs: readonly DsQueueTab<T>[];
  active: T;
  onSelect: (id: T) => void;
  /** Nome acessível do grupo (ex.: "Status da conversa"). */
  label: string;
}

function QueueTabButton({
  pressed,
  onPress,
  children,
}: {
  pressed: boolean;
  onPress: () => void;
  children: string;
}): JSX.Element {
  const ref = useRef<HTMLElementTagNameMap['s-press-button']>(null);
  const pressedRef = useRef(pressed);
  pressedRef.current = pressed;
  useElementProperties(ref, { pressed });
  useElementEvent(ref, 'click', () => {
    onPress();
    queueMicrotask(() => {
      if (ref.current && ref.current.pressed !== pressedRef.current)
        ref.current.pressed = pressedRef.current;
    });
  });
  return <s-press-button ref={ref}>{children}</s-press-button>;
}

export function DsQueueTabs<T extends string>({
  tabs,
  active,
  onSelect,
  label,
}: DsQueueTabsProps<T>): JSX.Element {
  return (
    <div role="group" aria-label={label} aria-live="polite" data-testid="queue-tabs">
      <s-stack direction="inline" gap="small-200">
        {tabs.map((t) => (
          <QueueTabButton key={t.id} pressed={active === t.id} onPress={() => onSelect(t.id)}>
            {typeof t.count === 'number' ? `${t.label} (${t.count})` : t.label}
          </QueueTabButton>
        ))}
      </s-stack>
    </div>
  );
}

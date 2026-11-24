'use client';

// Story 20.16a — botão de alternância CONTROLADO sobre <s-press-button> (React 18): `pressed` vai como
// PROPRIEDADE (o React 18 mandaria o atributo `pressed="false"`, lido como ligado). O clique do usuário
// alterna o elemento na hora; o estado do pai manda — se ele não mudar (ex.: clicar na opção que já
// estava escolhida), o elemento volta ao valor do estado, como um <input> controlado.
// Usado nos grupos de escolha (AND/OR do editor de filtros) e nos presets de países do Tracker.

import { useRef, type ReactNode } from 'react';

import { useElementProperties } from './use-custom-element';

type PressButtonElement = HTMLElementTagNameMap['s-press-button'];

export interface DsPressButtonProps {
  children: ReactNode;
  pressed: boolean;
  onClick: () => void;
  /** Nome acessível quando o texto visível não basta (deve começar pelo texto visível). */
  accessibilityLabel?: string;
  disabled?: boolean;
}

export function DsPressButton({ children, pressed, onClick, accessibilityLabel, disabled = false }: DsPressButtonProps): JSX.Element {
  const ref = useRef<PressButtonElement>(null);
  const pressedRef = useRef(pressed);
  pressedRef.current = pressed;
  useElementProperties(ref, { pressed, disabled });

  return (
    <s-press-button
      ref={ref}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled || undefined}
      onClick={() => {
        onClick();
        queueMicrotask(() => {
          const el = ref.current;
          if (el && el.pressed !== pressedRef.current) el.pressed = pressedRef.current;
        });
      }}
    >
      {children}
    </s-press-button>
  );
}

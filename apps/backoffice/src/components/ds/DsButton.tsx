'use client';

// Story 20.1 — <s-button> com booleanos como PROPRIEDADE (o React 18 do Next
// transforma `disabled={false}` no atributo `disabled="false"`, que o elemento
// leria como desabilitado). Texto e `onClick` funcionam direto no React 18.
// QA 21.5 — `disabled` também vai como ATRIBUTO (só quando true; nunca `disabled="false"`): o
// s-button às vezes inicializa o estado pelos atributos DEPOIS de recebermos a propriedade
// (corrida vista no Início: "Enviar" ativo com o campo vazio). Com o atributo, os dois batem.

import { useRef, type ReactNode } from 'react';

import { useElementProperties } from './use-custom-element';

type ButtonElement = HTMLElementTagNameMap['s-button'];

export interface DsButtonProps {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'auto';
  tone?: 'critical' | 'neutral' | 'auto';
  onClick?: () => void;
  href?: string;
  /** Story 20.5b — destino do link (`_blank` abre em nova aba; o navegador aplica `noopener`). */
  target?: '_blank' | '_self';
  disabled?: boolean;
  loading?: boolean;
  /** Abre/fecha um s-modal/s-popover/s-menu pelo id (sem estado no React). */
  commandFor?: string;
  command?: '--show' | '--hide' | '--toggle' | '--auto';
  /** Id de um <s-tooltip> com a dica do botão (Story 20.5a). */
  interestFor?: string;
  slot?: Lowercase<string>;
  accessibilityLabel?: string;
  id?: string;
  type?: 'button' | 'submit' | 'reset';
  /** Story 20.15c — `data-testid` no próprio s-button (telas que já tinham testids nos botões). */
  testId?: string;
  /** Story 24.7 — ícone do Polaris à esquerda do texto (ex.: `clipboard`, `download`). */
  icon?: NonNullable<ButtonElement['icon']>;
}

export function DsButton({
  children,
  variant,
  tone,
  onClick,
  href,
  target,
  disabled = false,
  loading = false,
  commandFor,
  command,
  interestFor,
  slot,
  accessibilityLabel,
  id,
  type,
  testId,
  icon,
}: DsButtonProps): JSX.Element {
  const ref = useRef<ButtonElement>(null);
  useElementProperties(ref, { disabled, loading });
  return (
    <s-button
      ref={ref}
      id={id}
      disabled={disabled || undefined}
      slot={slot}
      variant={variant}
      tone={tone}
      href={href}
      target={target}
      type={type}
      commandFor={commandFor}
      command={command}
      interestFor={interestFor}
      accessibilityLabel={accessibilityLabel}
      onClick={onClick}
      data-testid={testId}
      icon={icon}
    >
      {children}
    </s-button>
  );
}

'use client';

// Story 20.15b — botão só-ícone do DS (`s-button` com `icon` e `accessibilityLabel`), com `disabled` como
// PROPRIEDADE e atributo (mesma regra do DsButton: o React 18 mandaria `disabled="false"`). Usado nas
// barras de ferramenta (atualizar, página anterior/próxima, fechar).

import { useRef } from 'react';

import { useElementProperties } from './use-custom-element';

type ButtonElement = HTMLElementTagNameMap['s-button'];
type IconType = NonNullable<ButtonElement['icon']>;

export interface DsIconButtonProps {
  icon: IconType;
  /** Nome acessível (o botão não tem texto visível). */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'auto';
  tone?: 'critical' | 'neutral' | 'auto';
  interestFor?: string;
}

export function DsIconButton({ icon, label, onClick, disabled = false, variant = 'tertiary', tone, interestFor }: DsIconButtonProps): JSX.Element {
  const ref = useRef<ButtonElement>(null);
  useElementProperties(ref, { disabled });
  return (
    <s-button
      ref={ref}
      icon={icon}
      variant={variant}
      tone={tone}
      accessibilityLabel={label}
      interestFor={interestFor}
      disabled={disabled || undefined}
      onClick={onClick}
    />
  );
}

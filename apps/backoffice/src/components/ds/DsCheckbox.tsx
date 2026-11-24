'use client';

// Story 20.5a — checkbox CONTROLADO sobre <s-checkbox> (React 18).
//
// `checked` e `indeterminate` são PROPRIEDADES (o `indeterminate` do s-checkbox nem tem
// atributo). O clique do usuário muda o elemento na hora; se o estado do pai não aceitar a
// mudança (ex.: seleção controlada que recusa), o elemento volta ao valor do estado — igual
// ao <input type="checkbox"> controlado do React.

import { useRef } from 'react';

import { useElementEvent, useElementProperties } from './use-custom-element';

type CheckboxElement = HTMLElementTagNameMap['s-checkbox'];

export interface DsCheckboxProps {
  /** Rótulo em português (também o nome acessível). */
  label: string;
  checked: boolean;
  /** Recebe o novo estado marcado/desmarcado escolhido pelo usuário. */
  onChange: (checked: boolean) => void;
  /** Estado "alguns" (ex.: cabeçalho de tabela com seleção parcial). Visual apenas. */
  indeterminate?: boolean;
  disabled?: boolean;
  /** Esconde o rótulo na tela, mantendo-o para o leitor de tela (ex.: coluna de seleção). */
  labelHidden?: boolean;
  details?: string;
  error?: string;
  name?: string;
  id?: string;
}

export function DsCheckbox({
  label,
  checked,
  onChange,
  indeterminate = false,
  disabled = false,
  labelHidden = false,
  details,
  error,
  name,
  id,
}: DsCheckboxProps): JSX.Element {
  const ref = useRef<CheckboxElement>(null);
  // Estado mais recente, lido pelo microtask abaixo (atualizado no render).
  const stateRef = useRef({ checked, indeterminate });
  stateRef.current = { checked, indeterminate };

  useElementProperties(ref, {
    checked,
    indeterminate,
    disabled,
    error: error ?? '',
    details: details ?? '',
  });

  useElementEvent(ref, 'change', (event) => {
    const el = event.currentTarget as CheckboxElement | null;
    if (!el) return;
    onChange(Boolean(el.checked));
    queueMicrotask(() => {
      const current = ref.current;
      if (!current) return;
      const state = stateRef.current;
      if (current.checked !== state.checked) current.checked = state.checked;
      if (current.indeterminate !== state.indeterminate) current.indeterminate = state.indeterminate;
    });
  });

  return (
    <s-checkbox
      ref={ref}
      id={id}
      name={name}
      label={label}
      labelAccessibilityVisibility={labelHidden ? 'exclusive' : undefined}
    />
  );
}

'use client';

// Story 20.4b — campo de senha CONTROLADO sobre <s-password-field> (React 18).
//
// Mesmo padrão do DsTextField (propriedade + `useElementEvent`). O valor fica
// só na propriedade `value` do elemento — nunca vira atributo, `title` nem
// `aria-*`. Segredos salvos NÃO são reidratados: a tela começa com `value=""`
// e mostra só a versão mascarada que o servidor devolve.

import { useRef } from 'react';

import { useElementEvent, useElementProperties } from './use-custom-element';

type PasswordFieldElement = HTMLElementTagNameMap['s-password-field'];

export interface DsPasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Mensagem de validação (vazio/undefined = sem erro). */
  error?: string;
  details?: string;
  placeholder?: string;
  name?: string;
  id?: string;
  disabled?: boolean;
  required?: boolean;
  /** Padrão `new-password`: o navegador não preenche com uma senha salva. */
  autocomplete?: 'new-password' | 'current-password' | 'off';
  /** Disparado ao confirmar (blur/Enter) — o `change` nativo do componente. */
  onCommit?: (value: string) => void;
}

export function DsPasswordField({
  label,
  value,
  onChange,
  error,
  details,
  placeholder,
  name,
  id,
  disabled = false,
  required = false,
  autocomplete = 'new-password',
  onCommit,
}: DsPasswordFieldProps): JSX.Element {
  const ref = useRef<PasswordFieldElement>(null);
  // Valor mais recente do estado, lido pelo microtask abaixo (atualizado no render).
  const valueRef = useRef(value);
  valueRef.current = value;

  useElementProperties(ref, {
    value,
    error: error ?? '',
    details: details ?? '',
    disabled,
    required,
    autocomplete,
  });

  useElementEvent(ref, 'input', (event) => {
    const el = event.currentTarget as PasswordFieldElement | null;
    if (!el) return;
    onChange(el.value);
    // Igual ao <input> controlado do React: se o estado não aceitou o valor
    // digitado, o campo volta para o valor do estado.
    queueMicrotask(() => {
      if (ref.current && ref.current.value !== valueRef.current) ref.current.value = valueRef.current;
    });
  });
  useElementEvent(ref, 'change', (event) => {
    const el = event.currentTarget as PasswordFieldElement | null;
    if (el) onCommit?.(el.value);
  });

  return <s-password-field ref={ref} id={id} label={label} name={name} placeholder={placeholder} />;
}

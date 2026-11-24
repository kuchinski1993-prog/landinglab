'use client';

// Story 20.1 — campo de texto CONTROLADO sobre <s-text-field> (React 18).

import { useRef } from 'react';

import { useElementEvent, useElementProperties } from './use-custom-element';

type TextFieldElement = HTMLElementTagNameMap['s-text-field'];

export interface DsTextFieldProps {
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
  /** Story 20.5b — esconde o rótulo na tela (continua para leitor de tela; ex.: célula de tabela). */
  labelHidden?: boolean;
  /** Story 20.10d — limite de caracteres do campo (mesmo `maxLength` do campo antigo). */
  maxLength?: number;
  /** Disparado ao confirmar (blur/Enter) — o `change` nativo do componente. */
  onCommit?: (value: string) => void;
  /** Stories 20.11c/d — texto fixo antes do valor (ex.: o domínio antes do caminho da etapa). */
  prefix?: string;
}

export function DsTextField({
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
  labelHidden = false,
  maxLength,
  onCommit,
  prefix,
}: DsTextFieldProps): JSX.Element {
  const ref = useRef<TextFieldElement>(null);
  // Valor mais recente do estado, lido pelo microtask abaixo (atualizado no render).
  const valueRef = useRef(value);
  valueRef.current = value;

  useElementProperties(ref, {
    value,
    error: error ?? '',
    details: details ?? '',
    disabled,
    required,
    maxLength,
  });

  useElementEvent(ref, 'input', (event) => {
    const el = event.currentTarget as TextFieldElement | null;
    if (!el) return;
    onChange(el.value);
    // Igual ao <input> controlado do React: se o estado não aceitou o valor
    // digitado, o campo volta para o valor do estado.
    queueMicrotask(() => {
      if (ref.current && ref.current.value !== valueRef.current) ref.current.value = valueRef.current;
    });
  });
  useElementEvent(ref, 'change', (event) => {
    const el = event.currentTarget as TextFieldElement | null;
    if (el) onCommit?.(el.value);
  });

  return (
    <s-text-field
      ref={ref}
      id={id}
      label={label}
      name={name}
      placeholder={placeholder}
      prefix={prefix}
      labelAccessibilityVisibility={labelHidden ? 'exclusive' : undefined}
    />
  );
}

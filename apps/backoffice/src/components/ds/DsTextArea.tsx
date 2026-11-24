'use client';

// Story 20.5b (PR1) — área de texto CONTROLADA sobre <s-text-area> (React 18). Mesmo contrato do
// DsTextField + `rows` (linhas visíveis) e `maxLength`. Uso: descrição e ficha técnica do produto.
// Story 20.15d (O-28) — `autoFocus` opcional: foca o campo uma vez, na montagem.

import { useEffect, useRef } from 'react';

import { useElementEvent, useElementProperties } from './use-custom-element';

type TextAreaElement = HTMLElementTagNameMap['s-text-area'];

export interface DsTextAreaProps {
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
  /** Linhas visíveis (padrão do componente: 2). */
  rows?: number;
  maxLength?: number;
  /** Esconde o rótulo visualmente (continua para leitor de tela). */
  labelHidden?: boolean;
  /** Disparado ao confirmar (blur) — o `change` nativo do componente. */
  onCommit?: (value: string) => void;
  /** Foca o campo uma vez, na montagem (padrão: false). Apresentação apenas. */
  autoFocus?: boolean;
}

export function DsTextArea({
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
  rows,
  maxLength,
  labelHidden = false,
  onCommit,
  autoFocus = false,
}: DsTextAreaProps): JSX.Element {
  const ref = useRef<TextAreaElement>(null);
  // Valor mais recente do estado, lido pelo microtask abaixo (atualizado no render).
  const valueRef = useRef(value);
  valueRef.current = value;

  useElementProperties(ref, {
    value,
    error: error ?? '',
    details: details ?? '',
    disabled,
    required,
    rows,
    maxLength,
  });

  useElementEvent(ref, 'input', (event) => {
    const el = event.currentTarget as TextAreaElement | null;
    if (!el) return;
    onChange(el.value);
    // Igual ao <textarea> controlado do React: se o estado não aceitou o valor
    // digitado, o campo volta para o valor do estado.
    queueMicrotask(() => {
      if (ref.current && ref.current.value !== valueRef.current) ref.current.value = valueRef.current;
    });
  });
  useElementEvent(ref, 'change', (event) => {
    const el = event.currentTarget as TextAreaElement | null;
    if (el) onCommit?.(el.value);
  });

  // O <s-text-area> é um Web Component: só foca depois de definido (o bundle do CDN pode chegar depois
  // da montagem). Uma vez, na montagem; se o componente sair da tela antes, não foca.
  useEffect(() => {
    if (!autoFocus) return undefined;
    const el = ref.current;
    if (!el || typeof window === 'undefined' || !window.customElements) return undefined;
    let active = true;
    void window.customElements.whenDefined('s-text-area').then(() => {
      if (active && el.isConnected) el.focus();
    });
    return () => {
      active = false;
    };
  }, [autoFocus]);

  return (
    <s-text-area
      ref={ref}
      id={id}
      label={label}
      name={name}
      placeholder={placeholder}
      labelAccessibilityVisibility={labelHidden ? 'exclusive' : undefined}
    />
  );
}

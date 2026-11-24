'use client';

// Story 20.4b — campo numérico CONTROLADO sobre <s-number-field> (React 18).
//
// O valor é sempre TEXTO (`onChange(string)`): a tela decide como converter,
// exatamente como fazia com o <input type="number"> (ex.: a taxa de câmbio vai
// como string para a API). `min`/`max`/`step` são propriedades numéricas.

import { useRef } from 'react';

import { useElementEvent, useElementProperties } from './use-custom-element';

type NumberFieldElement = HTMLElementTagNameMap['s-number-field'];

export interface DsNumberFieldProps {
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
  min?: number;
  max?: number;
  step?: number;
  /** Teclado no celular: `decimal` (padrão do componente) ou `numeric` (inteiros). */
  inputMode?: 'decimal' | 'numeric';
  prefix?: string;
  suffix?: string;
  /** Disparado ao confirmar (blur/Enter) — o `change` nativo do componente. */
  onCommit?: (value: string) => void;
}

export function DsNumberField({
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
  min,
  max,
  step,
  inputMode,
  prefix,
  suffix,
  onCommit,
}: DsNumberFieldProps): JSX.Element {
  const ref = useRef<NumberFieldElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useElementProperties(ref, {
    value,
    error: error ?? '',
    details: details ?? '',
    disabled,
    required,
    min,
    max,
    step,
    inputMode,
  });

  useElementEvent(ref, 'input', (event) => {
    const el = event.currentTarget as NumberFieldElement | null;
    if (!el) return;
    onChange(el.value);
    // Se o estado não aceitou o valor digitado, o campo volta ao valor do estado.
    queueMicrotask(() => {
      if (ref.current && ref.current.value !== valueRef.current) ref.current.value = valueRef.current;
    });
  });
  useElementEvent(ref, 'change', (event) => {
    const el = event.currentTarget as NumberFieldElement | null;
    if (el) onCommit?.(el.value);
  });

  // `prefix`/`suffix` vão como ATRIBUTO: `Element.prototype.prefix` é só-leitura (prefixo de
  // namespace do DOM), então gravar a propriedade lança TypeError se o elemento não a redefinir
  // (Story 20.5a — primeiro uso, no "Editar em massa" de Produtos).
  return (
    <s-number-field ref={ref} id={id} label={label} name={name} placeholder={placeholder} prefix={prefix} suffix={suffix} />
  );
}

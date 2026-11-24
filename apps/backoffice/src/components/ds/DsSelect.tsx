'use client';

// Story 20.1 — select CONTROLADO sobre <s-select>/<s-option> (React 18).

import { useRef } from 'react';

import { useElementEvent, useElementProperties } from './use-custom-element';

type SelectElement = HTMLElementTagNameMap['s-select'];

export interface DsSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface DsSelectProps {
  label: string;
  value: string;
  options: readonly DsSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
  details?: string;
  name?: string;
  id?: string;
  disabled?: boolean;
  /** Story 20.15b — esconde o rótulo na tela (continua para o leitor de tela). */
  labelHidden?: boolean;
}

export function DsSelect({
  label,
  value,
  options,
  onChange,
  placeholder,
  error,
  details,
  name,
  id,
  disabled = false,
  labelHidden = false,
}: DsSelectProps): JSX.Element {
  const ref = useRef<SelectElement>(null);
  useElementProperties(ref, { value, error: error ?? '', details: details ?? '', disabled });
  useElementEvent(ref, 'change', (event) => {
    const el = event.currentTarget as SelectElement | null;
    if (el && el.value !== value) onChange(el.value);
  });

  return (
    <s-select
      ref={ref}
      id={id}
      label={label}
      name={name}
      placeholder={placeholder}
      labelAccessibilityVisibility={labelHidden ? 'exclusive' : undefined}
    >
      {options.map((option) => (
        <s-option key={option.value} value={option.value} disabled={option.disabled || undefined}>
          {option.label}
        </s-option>
      ))}
    </s-select>
  );
}

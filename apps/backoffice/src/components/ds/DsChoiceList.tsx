'use client';

// @ds-migrated — Story 20.10c: escolha única CONTROLADA sobre <s-choice-list> (adaptado do
// `import/_components/ChoiceList.tsx`, Story 20.5c): `values` como PROPRIEDADE e o `change` do elemento
// via addEventListener (React 18). Acrescenta texto de apoio por opção, rótulo só para leitor de tela e
// campo desabilitado.

import { useMemo, useRef } from 'react';

import { useElementEvent, useElementProperties } from './use-custom-element';

type ChoiceListElement = HTMLElementTagNameMap['s-choice-list'];

export interface DsChoiceOption<V extends string> {
  value: V;
  label: string;
  /** Texto de apoio abaixo do rótulo da opção. */
  details?: string;
}

export interface DsChoiceListProps<V extends string> {
  label: string;
  value: V;
  options: ReadonlyArray<DsChoiceOption<V>>;
  onChange: (value: V) => void;
  /** Esconde o rótulo na tela (continua para leitor de tela). */
  labelHidden?: boolean;
  disabled?: boolean;
  name?: string;
}

export function DsChoiceList<V extends string>({
  label,
  value,
  options,
  onChange,
  labelHidden = false,
  disabled = false,
  name,
}: DsChoiceListProps<V>): JSX.Element {
  const ref = useRef<ChoiceListElement>(null);
  const values = useMemo(() => [value], [value]);
  useElementProperties(ref, { values, disabled });
  useElementEvent(ref, 'change', (event) => {
    const el = event.currentTarget as ChoiceListElement | null;
    const next = el?.values?.[0];
    const option = options.find((o) => o.value === next);
    if (option && option.value !== value) onChange(option.value);
  });

  return (
    <s-choice-list ref={ref} label={label} name={name} labelAccessibilityVisibility={labelHidden ? 'exclusive' : undefined}>
      {options.map((option) => (
        <s-choice key={option.value} value={option.value} selected={option.value === value || undefined}>
          {option.label}
          {option.details ? <s-text slot="details">{option.details}</s-text> : null}
        </s-choice>
      ))}
    </s-choice-list>
  );
}

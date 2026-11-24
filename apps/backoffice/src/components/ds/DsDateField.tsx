'use client';

// Story 20.11c (PR C) — campo de data controlado sobre <s-date-field> (valor `AAAA-MM-DD`). O `type="date"`
// do s-text-field não existe; o DS tem `s-date-field`. Mesmo contrato dos campos locais de Pedidos das
// landings (20.10d) e de Leads, agora reutilizável.

import { useRef } from 'react';

import { useElementEvent, useElementProperties } from './use-custom-element';

type DateFieldElement = HTMLElementTagNameMap['s-date-field'];

export interface DsDateFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  details?: string;
  disabled?: boolean;
  id?: string;
}

export function DsDateField({ label, value, onChange, error, details, disabled = false, id }: DsDateFieldProps): JSX.Element {
  const ref = useRef<DateFieldElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  useElementProperties(ref, { value, error: error ?? '', details: details ?? '', disabled });
  const handle = (event: Event): void => {
    const el = event.currentTarget as DateFieldElement | null;
    if (el && el.value !== valueRef.current) onChange(el.value);
  };
  useElementEvent(ref, 'change', handle);
  useElementEvent(ref, 'input', handle);
  return <s-date-field ref={ref} id={id} label={label} />;
}

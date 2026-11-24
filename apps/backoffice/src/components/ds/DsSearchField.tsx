'use client';

// Story 20.6 — campo de busca CONTROLADO sobre <s-search-field> (React 18), com botão de limpar.
// Usado nas listas com busca (Pedidos, Produtos — 20.5a).

import { useRef } from 'react';

import { DsButton } from './DsButton';
import { useElementEvent, useElementProperties } from './use-custom-element';

type SearchFieldElement = HTMLElementTagNameMap['s-search-field'];

export interface DsSearchFieldProps {
  /** Nome acessível do campo (ex.: "Buscar pedidos"). */
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Chamado depois de limpar pelo botão (o valor já foi zerado via `onChange('')`). */
  onClear?: () => void;
  /** Esconde o rótulo visualmente (continua para leitor de tela). */
  labelHidden?: boolean;
  /** Rótulo do botão de limpar (padrão "Limpar busca"). */
  clearLabel?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
}

export function DsSearchField({
  label,
  value,
  onChange,
  placeholder,
  onClear,
  labelHidden = false,
  clearLabel = 'Limpar busca',
  id,
  name,
  disabled = false,
}: DsSearchFieldProps): JSX.Element {
  const ref = useRef<SearchFieldElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useElementProperties(ref, { value, disabled });

  useElementEvent(ref, 'input', (event) => {
    const el = event.currentTarget as SearchFieldElement | null;
    if (!el) return;
    onChange(el.value);
    // Mesmo comportamento do DsTextField: se o estado recusou o valor, o campo volta a ele.
    queueMicrotask(() => {
      if (ref.current && ref.current.value !== valueRef.current) ref.current.value = valueRef.current;
    });
  });

  const clear = (): void => {
    onChange('');
    onClear?.();
  };

  // Story 20.5f — grade em vez de pilha em linha: o campo ocupa a largura disponível (na pilha ele
  // encolhia até o tamanho do placeholder — "Buscar p…" cortado em Pedidos e Produtos).
  return (
    <s-grid gridTemplateColumns={value ? '1fr auto' : '1fr'} gap="small-200" alignItems="end">
      <s-search-field
        ref={ref}
        id={id}
        name={name}
        label={label}
        labelAccessibilityVisibility={labelHidden ? 'exclusive' : undefined}
        placeholder={placeholder}
      />
      {value ? (
        <DsButton variant="tertiary" onClick={clear} disabled={disabled}>
          {clearLabel}
        </DsButton>
      ) : null}
    </s-grid>
  );
}

'use client';

// @ds-migrated — Story 20.7d-2: grupo recolhível do editor de tema (tokens, aparência, identidade).
//
// Substitui o par "botão + `Collapsible`" do Polaris React. Controlado (o estado aberto/fechado fica
// em quem usa, como antes). Botão nativo com `aria-expanded`/`aria-controls` (teclado: Tab, Enter e
// Espaço); o conteúdo só existe no DOM quando aberto — igual ao `Collapsible` fechado, que não
// renderizava os filhos.

import type { ReactNode } from 'react';

export interface DsDisclosureProps {
  /** Texto do botão (também o nome acessível). */
  label: string;
  open: boolean;
  onToggle: () => void;
  /** Id da região de conteúdo (`aria-controls`). */
  id: string;
  children: ReactNode;
  /** Algo antes do rótulo (ex.: amostras do esquema de cor). */
  leading?: ReactNode;
  /** `section` = título de grupo em caixa alta; `card` = caixa com borda (ex.: aparência da seção);
   *  `plain` = sem borda (quem usa já desenha as divisórias — ex.: barra lateral do editor). */
  variant?: 'section' | 'card' | 'plain';
}

export function DsDisclosure({
  label,
  open,
  onToggle,
  id,
  children,
  leading,
  variant = 'section',
}: DsDisclosureProps): JSX.Element {
  const card = variant === 'card';
  return (
    <div
      style={
        card
          ? {
              borderRadius: 'var(--ds-radius-200, 0.5rem)',
              border: '1px solid var(--ds-color-border, #e3e3e3)',
              background: 'var(--ds-color-surface-secondary, #f7f7f7)',
            }
          : variant === 'plain'
            ? undefined
            : { borderBlockStart: '1px solid var(--ds-color-border, #e3e3e3)' }
      }
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          inlineSize: '100%',
          padding: card ? '10px 12px' : variant === 'plain' ? '8px 0' : '10px 0',
          background: 'none',
          border: 'none',
          borderRadius: 'var(--ds-radius-200, 0.5rem)',
          cursor: 'pointer',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'start',
        }}
      >
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {leading}
          <s-text type="strong" color={card ? undefined : 'subdued'}>
            {label}
          </s-text>
        </s-stack>
        <s-icon type={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      {open ? (
        <div id={id} style={{ padding: card ? '0 12px 12px' : '0 0 12px' }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

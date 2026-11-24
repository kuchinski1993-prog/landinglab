'use client';

// @ds-migrated — Story 20.7d-2: controle deslizante do editor de tema (substitui o `RangeSlider` do
// Polaris React nos painéis de aparência, bloco e seção).
//
// O Polaris Web Components não tem slider (mesma decisão da 20.10b/20.10d: `<input type="range">`
// nativo com o visual `.ds-range`). O contrato de `onChange` é o MESMO do `RangeSlider` antigo
// (`number | [number, number]`, sempre número aqui), para os handlers dos painéis continuarem
// idênticos — o valor gravado no tema não muda. `output` mostra o valor atual ao lado do rótulo.

import { useId } from 'react';

export interface DsRangeSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Mesmo contrato do `RangeSlider` do Polaris React (aqui sempre recebe um número). */
  onChange: (value: number | [number, number]) => void;
  /** Texto de apoio abaixo do controle. */
  details?: string;
  /** Mostra o valor atual ao lado do rótulo. */
  output?: boolean;
  disabled?: boolean;
  id?: string;
}

export function DsRangeSlider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  details,
  output = false,
  disabled = false,
  id,
}: DsRangeSliderProps): JSX.Element {
  const autoId = useId();
  const inputId = id ?? `ds-range-${autoId.replace(/:/g, '')}`;
  const detailsId = details ? `${inputId}-details` : undefined;
  return (
    <s-stack gap="small-100">
      <div className="ds-range-label">
        <label htmlFor={inputId}>{label}</label>
        {output ? <s-text color="subdued">{String(value)}</s-text> : null}
      </div>
      <input
        id={inputId}
        className="ds-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={detailsId}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {details ? (
        <span id={detailsId}>
          <s-text color="subdued">{details}</s-text>
        </span>
      ) : null}
    </s-stack>
  );
}

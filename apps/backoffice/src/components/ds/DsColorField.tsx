'use client';

// @ds-migrated — Story 20.7d-2: campo de cor do editor de tema (amostra + código).
//
// Mesmo desenho do campo antigo do editor (seletor nativo de cor + campo de texto com o código),
// agora com o `DsTextField` do DS. Os dois controles chamam o MESMO `onChange` com o valor exato
// (o código digitado vai como está — `#fff`, `rgba(...)`, vazio —, como antes). O `s-color-field`
// do DS não foi usado de propósito: ele normaliza o valor, e o tema gravado não pode mudar.

import { DsTextField } from './DsTextField';

export interface DsColorFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Cor mostrada na amostra quando o valor está vazio (padrão: o próprio valor). */
  swatchFallback?: string;
  placeholder?: string;
  details?: string;
  id?: string;
}

export function DsColorField({
  label,
  value,
  onChange,
  swatchFallback,
  placeholder,
  details,
  id,
}: DsColorFieldProps): JSX.Element {
  const swatch = swatchFallback !== undefined ? value || swatchFallback : value;
  return (
    <s-stack gap="small-200">
      <s-text type="strong">{label}</s-text>
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <input
          type="color"
          aria-label={`Escolher cor: ${label}`}
          value={swatch}
          onChange={(e) => onChange(e.target.value)}
          style={{
            blockSize: 32,
            inlineSize: 40,
            flexShrink: 0,
            cursor: 'pointer',
            padding: 2,
            borderRadius: 'var(--ds-radius-200, 0.5rem)',
            border: '1px solid var(--ds-color-border, #e3e3e3)',
            background: 'var(--ds-color-surface, #fff)',
          }}
        />
        <div style={{ flex: 1, minInlineSize: 0 }}>
          <DsTextField
            id={id}
            label={label}
            labelHidden
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            details={details}
          />
        </div>
      </s-stack>
    </s-stack>
  );
}

'use client';

// @ds-migrated — Story 20.3 (Decisão 8): gráfico de barras próprio, em SVG puro.
//
// O Polaris Web Components 2.x não tem componente de gráfico, e uma biblioteca
// traria peso e dependência de React. Uma moeda por gráfico (nunca somar
// moedas). Acessível: o gráfico tem `aria-label` com o total; as barras são
// UMA parada de Tab (roving tabindex) e as setas/Home/End navegam entre elas,
// cada uma com rótulo; "Ver como tabela" (aria-expanded/aria-controls) mostra
// os mesmos dados numa tabela. Eixo e dica ficam em HTML, fora da área
// esticada do SVG (o texto não deforma). Cores dos tokens de `ds-tokens.css`.

import { useId, useRef, useState, type KeyboardEvent } from 'react';

export interface DsSalesChartPoint {
  key: string;
  /** Rótulo do eixo (ex.: "14h", "26/10"). */
  label: string;
  value: number;
  /** Texto extra do ponto (ex.: "2 pedidos"). */
  detail?: string;
}

export interface DsSalesChartProps {
  points: readonly DsSalesChartPoint[];
  formatValue: (value: number) => string;
  /** Descrição curta para leitores de tela (o total é acrescentado). */
  label: string;
  /** Cabeçalho da coluna de período na tabela ("Hora", "Dia"). */
  periodHeading?: string;
}

const WIDTH = 640;
const HEIGHT = 160;
const PAD_TOP = 4;

function axisStep(count: number): number {
  if (count <= 8) return 1;
  if (count <= 16) return 2;
  if (count <= 24) return 3;
  return 5;
}

const safe = (v: number): number => (Number.isFinite(v) ? v : 0);

export function DsSalesChart({ points, formatValue, label, periodHeading = 'Período' }: DsSalesChartProps): JSX.Element {
  const [active, setActive] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const barRefs = useRef<Array<SVGGElement | null>>([]);
  const total = points.reduce((sum, p) => sum + safe(p.value), 0);
  const max = Math.max(0, ...points.map((p) => safe(p.value)));
  const innerH = HEIGHT - PAD_TOP;
  const slot = points.length > 0 ? WIDTH / points.length : WIDTH;
  const barW = Math.max(2, slot * 0.7);
  const step = axisStep(points.length);
  const ariaLabel = `${label}. Total: ${formatValue(total)}. Use as setas para percorrer as barras.`;
  const activePoint = active !== null ? points[active] : undefined;
  const tabStop = Math.min(focusIndex, Math.max(points.length - 1, 0));

  const pointLabel = (p: DsSalesChartPoint): string =>
    `${p.label}: ${formatValue(safe(p.value))}${p.detail ? ` (${p.detail})` : ''}`;

  function moveFocus(next: number): void {
    if (points.length === 0) return;
    const i = Math.max(0, Math.min(points.length - 1, next));
    setFocusIndex(i);
    barRefs.current[i]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>): void {
    const keys: Record<string, number> = {
      ArrowRight: tabStop + 1,
      ArrowDown: tabStop + 1,
      ArrowLeft: tabStop - 1,
      ArrowUp: tabStop - 1,
      Home: 0,
      End: points.length - 1,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    moveFocus(next);
  }

  return (
    <div className="ds-chart">
      <div className="ds-chart__tooltip" aria-hidden="true">
        {activePoint ? `${activePoint.label}: ${formatValue(safe(activePoint.value))}${activePoint.detail ? ` · ${activePoint.detail}` : ''}` : ' '}
      </div>
      <svg
        className="ds-chart__svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="group"
        aria-label={ariaLabel}
        data-testid="ds-sales-chart"
        preserveAspectRatio="none"
        onKeyDown={onKeyDown}
      >
        {[0, 0.5, 1].map((f) => (
          <line key={f} className="ds-chart__grid" x1={0} x2={WIDTH} y1={PAD_TOP + innerH * (1 - f)} y2={PAD_TOP + innerH * (1 - f)} />
        ))}
        {points.map((p, i) => {
          const value = safe(p.value);
          const h = max > 0 ? (value / max) * innerH : 0;
          const x = i * slot + (slot - barW) / 2;
          const text = pointLabel(p);
          return (
            <g
              key={p.key}
              ref={(el) => {
                barRefs.current[i] = el;
              }}
              tabIndex={i === tabStop ? 0 : -1}
              role="img"
              aria-label={text}
              className={active === i ? 'ds-chart__bar ds-chart__bar--active' : 'ds-chart__bar'}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => {
                setActive(i);
                setFocusIndex(i);
              }}
              onBlur={() => setActive(null)}
            >
              <title>{text}</title>
              {/* área de toque/hover do tamanho da coluna inteira */}
              <rect className="ds-chart__hit" x={i * slot} y={PAD_TOP} width={slot} height={innerH} />
              <rect className="ds-chart__fill" x={x} y={PAD_TOP + innerH - h} width={barW} height={Math.max(h, value > 0 ? 1 : 0)} />
            </g>
          );
        })}
      </svg>
      <div
        className="ds-chart__axis-row"
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${Math.max(points.length, 1)}, minmax(0, 1fr))` }}
      >
        {points.map((p, i) => (
          <span key={p.key} className="ds-chart__axis">
            {i % step === 0 ? p.label : ''}
          </span>
        ))}
      </div>
      <button
        type="button"
        className="ds-chart__toggle"
        aria-expanded={showTable}
        aria-controls={tableId}
        onClick={() => setShowTable((v) => !v)}
      >
        {showTable ? 'Ocultar tabela' : 'Ver como tabela'}
      </button>
      <div id={tableId} hidden={!showTable}>
        {showTable ? (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{periodHeading}</s-table-header>
              <s-table-header format="currency">Valor</s-table-header>
              <s-table-header>Detalhe</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {points.map((p) => (
                <s-table-row key={p.key}>
                  <s-table-cell>{p.label}</s-table-cell>
                  <s-table-cell>{formatValue(safe(p.value))}</s-table-cell>
                  <s-table-cell>{p.detail ?? ''}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : null}
      </div>
    </div>
  );
}

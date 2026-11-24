'use client';

// Story 20.15c (PR A) — tabela por colunas (`s-table`), no lugar do `DataTable` do TrustShield
// (`trustshield/components/design/DataTable.tsx`, Polaris React `IndexTable`). Mesmo contrato: colunas com
// `render`, `rows === null` = carregando, vazio com mensagem, `highlightRow` (ponto vermelho na 1ª
// coluna) e `onRowClick`. A linha só navega com `getRowHref` (junto de `onRowClick`): vira link (padrão 20.5e: `clickDelegate` + `s-link`):
// clique simples chama `onRowClick` uma vez; Ctrl/Cmd/Shift/botão do meio abrem o endereço em nova aba.

import type { ReactNode } from 'react';

import { DsRowLink } from './DsRowLink';

export interface DsDataTableColumn<T> {
  key: string;
  label: string;
  /** Conteúdo da célula. Sem `render`, imprime `String(row[key])`. */
  render?: (row: T) => ReactNode;
}

export interface DsDataTableProps<T> {
  rows: T[] | null;
  columns: DsDataTableColumn<T>[];
  getRowId: (row: T) => string;
  loading?: boolean;
  emptyMessage?: string;
  emptyTestId?: string;
  onRowClick?: (row: T) => void;
  /** Endereço da linha (Ctrl/Cmd-clique em nova aba). Sem ele, a linha não vira link. */
  getRowHref?: (row: T) => string;
  highlightRow?: (row: T) => boolean;
  testId?: string;
}

export function DsDataTable<T>({
  rows,
  columns,
  getRowId,
  loading = false,
  emptyMessage = 'Nada por aqui.',
  emptyTestId,
  onRowClick,
  getRowHref,
  highlightRow,
  testId,
}: DsDataTableProps<T>): JSX.Element {
  if (loading || rows === null) {
    return (
      <div className="ds-skeleton-card ds-table-state" aria-busy="true" data-testid={testId ? `${testId}-loading` : undefined}>
        <span className="ds-skeleton-line" />
        <span className="ds-skeleton-line" />
        <span className="ds-skeleton-line ds-skeleton-line--short" />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="ds-table-state ds-table-state--empty" data-testid={emptyTestId}>
        <s-paragraph color="subdued">{emptyMessage}</s-paragraph>
      </div>
    );
  }
  return (
    <div className="ds-table-scroll" data-testid={testId}>
      <s-table>
        <s-table-header-row>
          {columns.map((c) => (
            <s-table-header key={c.key}>{c.label}</s-table-header>
          ))}
        </s-table-header-row>
        <s-table-body>
          {rows.map((row) => {
            const id = getRowId(row);
            const href = getRowHref && onRowClick ? getRowHref(row) : undefined;
            const linkId = `row-link-${id}`;
            const highlighted = highlightRow?.(row) === true;
            return (
              <s-table-row
                key={id}
                clickDelegate={href ? linkId : undefined}
                data-highlighted={highlighted ? 'true' : undefined}
              >
                {columns.map((col, i) => {
                  const content = col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '—');
                  return (
                    <s-table-cell key={col.key}>
                      {i === 0 && highlighted ? <span className="ds-dot-critical" aria-hidden /> : null}
                      {i === 0 && href ? (
                        <DsRowLink id={linkId} href={href} onNavigate={() => onRowClick?.(row)}>
                          {content}
                        </DsRowLink>
                      ) : (
                        content
                      )}
                    </s-table-cell>
                  );
                })}
              </s-table-row>
            );
          })}
        </s-table-body>
      </s-table>
    </div>
  );
}

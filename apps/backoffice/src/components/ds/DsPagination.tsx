'use client';

// Story 20.6 — paginação por página/offset ("Anterior"/"Próxima" + resumo) no visual novo.
// Usada nas listas paginadas (Pedidos, Produtos — 20.5a). A página é 1-based.

import { DsButton } from './DsButton';

export interface DsPaginationProps {
  /** Página atual (começa em 1). */
  page: number;
  pageSize: number;
  total: number;
  /** Chamado com a nova página (nunca fora de 1..última). */
  onPage: (page: number) => void;
  /** `pages`: "Página X de Y · N pedidos"; `range`: "Exibindo X–Y de N produtos". */
  summary?: 'pages' | 'range';
  /** Substantivo no plural para o resumo (ex.: "pedidos", "produtos"). */
  noun: string;
  /** Desabilita os botões (ex.: enquanto carrega). */
  disabled?: boolean;
}

export function paginationSummary({
  page,
  pageSize,
  total,
  summary = 'pages',
  noun,
}: Pick<DsPaginationProps, 'page' | 'pageSize' | 'total' | 'summary' | 'noun'>): string {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (summary === 'range') {
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(total, page * pageSize);
    return `Exibindo ${start}–${end} de ${total} ${noun}`;
  }
  return `Página ${page} de ${totalPages} · ${total} ${noun}`;
}

export function DsPagination({
  page,
  pageSize,
  total,
  onPage,
  summary = 'pages',
  noun,
  disabled = false,
}: DsPaginationProps): JSX.Element {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const canPrev = page > 1;
  const canNext = page < totalPages;
  return (
    <nav aria-label="Paginação">
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-text color="subdued">{paginationSummary({ page, pageSize, total, summary, noun })}</s-text>
        <s-stack direction="inline" gap="small-200">
          <DsButton variant="secondary" disabled={disabled || !canPrev} onClick={() => !disabled && canPrev && onPage(page - 1)}>
            Anterior
          </DsButton>
          <DsButton variant="secondary" disabled={disabled || !canNext} onClick={() => !disabled && canNext && onPage(page + 1)}>
            Próxima
          </DsButton>
        </s-stack>
      </s-stack>
    </nav>
  );
}

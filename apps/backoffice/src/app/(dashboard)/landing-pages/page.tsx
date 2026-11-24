'use client';

// @ds-migrated — Story 20.10a: lista de landings (`/landing-pages`) no design system.
//
// Mesmas Server Actions (`getLandingPagesSummary({ status, q, limit: 24, offset })`,
// `deleteLandingPage(id)`) e mesma URL (`?q=&status=&page=`), agora lida sem confiar nela (página
// inválida → 1, status desconhecido → todas). Falha de carga mostra o banner pelo `code` com
// "Tentar de novo" e NUNCA "Nenhuma landing ainda" nem a lista antiga; o vazio só aparece quando a
// ação respondeu `total = 0` sem filtro. A Server Action não recebe `AbortSignal`: o
// `useAsyncState` descarta a resposta de uma busca já substituída (ordem garantida). Exclusão com
// confirmação; falha (retorno ou exceção) avisa com "Tentar de novo" e a linha continua; excluir o
// último item de uma página > 1 volta uma página. Retrabalho (feedback do owner): de volta à grade de
// cartões, cada um com a prévia da página no topo (`LandingCard`/`LandingPreview`).
// O editor (`/landing-pages/<id>/editor`), `new` e `domains` continuam em Polaris React.

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { LandingCard } from './_components/LandingCard';
import {
  countLabel,
  LANDING_GRID_COLUMNS,
  landingsUrl,
  PAGE_SIZE,
  parseListParams,
  plural,
  SEARCH_DEBOUNCE_MS,
  STATUS_OPTIONS,
  summaryArgs,
  type StatusFilter,
} from './_lib/landing-list';

import {
  ActionFeedback,
  ConfirmModal,
  DsButton,
  DsPageHeader,
  DsPagination,
  DsSearchField,
  DsSelect,
  EmptyBlock,
  PolarisGate,
  StateBoundary,
  useActionFeedback,
} from '@/components/ds';
import { useAsyncState } from '@/hooks/useAsyncState';
import { deleteLandingPage, getLandingPagesSummary } from '@/lib/landing-actions';
import type { LandingPageSummary, ListLandingsSummaryResult } from '@/lib/landing-types';

const DELETE_FALLBACK = 'Não foi possível excluir a landing. Tente de novo.';

function LandingPagesContent(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initial] = useState(() => parseListParams(searchParams));

  const [query, setQuery] = useState(initial.q);
  const [debouncedQuery, setDebouncedQuery] = useState(initial.q);
  const [status, setStatus] = useState<StatusFilter>(initial.status);
  const [page, setPage] = useState(initial.page);

  useEffect(() => {
    if (query === debouncedQuery) return undefined;
    const t = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, debouncedQuery]);

  const args = summaryArgs(debouncedQuery, status, page);
  // URL regravada com os valores já corrigidos (como antes: q/status/page só quando não são o padrão)
  // e só DEPOIS que a carga termina, e só pela carga vigente (como antes). No Next 14, uma navegação
  // (`router.replace`) despachada enquanto uma Server Action espera na fila do router descarta essa
  // ação: a promessa nunca resolve e a lista fica presa em "Carregando" (trocas rápidas de filtro em
  // produção; no `next dev`, com o modo estrito, já na 1ª carga).
  const href = landingsUrl(debouncedQuery, status, page);
  const list = useAsyncState<ListLandingsSummaryResult>(
    async (signal) => {
      try {
        return await getLandingPagesSummary(args);
      } finally {
        if (!signal.aborted) router.replace(href, { scroll: false });
      }
    },
    [args.status, args.q, args.offset],
  );

  const feedback = useActionFeedback();
  const [deleteTarget, setDeleteTarget] = useState<LandingPageSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const deletingRef = useRef(false);

  const data = list.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasFilters = debouncedQuery !== '' || status !== 'all';

  function changeQuery(value: string): void {
    setQuery(value);
    setPage(1);
  }

  function clearFilters(): void {
    setQuery('');
    setDebouncedQuery('');
    setStatus('all');
    setPage(1);
  }

  async function handleConfirmDelete(): Promise<void> {
    const target = deleteTarget;
    if (!target || deletingRef.current) return; // duplo clique = uma chamada
    deletingRef.current = true;
    setIsDeleting(true);
    feedback.dismiss();
    const retry = (): void => setDeleteTarget(target);
    try {
      const result = await deleteLandingPage(target.id);
      // Falha: o modal fecha para o aviso (com "Tentar de novo", que reabre a confirmação) ficar à vista; a linha continua.
      setDeleteTarget(null);
      if (!result.ok) {
        feedback.failure(result.message || DELETE_FALLBACK, { onRetry: retry });
        return;
      }
      feedback.success('Landing excluída.');
      // Era o último item de uma página > 1: volta uma página em vez de ficar numa página que não existe.
      if (items.length === 1 && page > 1) setPage(page - 1);
      else list.retry();
    } catch (err) {
      setDeleteTarget(null);
      feedback.failure(err, { fallbackMessage: DELETE_FALLBACK, onRetry: retry });
    } finally {
      deletingRef.current = false;
      setIsDeleting(false);
    }
  }

  let content: JSX.Element;
  if (list.status === 'error') {
    content = <StateBoundary status="error" error={list.error} errorTitle="Não foi possível carregar as landings" onRetry={list.retry} />;
  } else if (list.status === 'loading' || !data) {
    content = <StateBoundary status="loading" loadingLabel="Carregando landings" loadingLines={5} onRetry={list.retry} />;
  } else if (total > 0 && items.length === 0) {
    // Link salvo com página além da última: há landings, só não nesta página.
    content = (
      <EmptyBlock
        heading="Nenhuma landing nesta página"
        action={
          <DsButton variant="secondary" onClick={() => setPage(1)}>
            Ir para a primeira página
          </DsButton>
        }
      >
        {`A lista tem ${countLabel(total)}; esta página passou do fim.`}
      </EmptyBlock>
    );
  } else if (items.length === 0) {
    content = hasFilters ? (
      <EmptyBlock
        heading="Nenhuma landing corresponde aos filtros."
        action={
          <DsButton variant="secondary" onClick={clearFilters}>
            Limpar filtros
          </DsButton>
        }
      >
        Tente outra busca ou outro status.
      </EmptyBlock>
    ) : (
      <EmptyBlock
        heading="Nenhuma landing ainda"
        action={
          <DsButton variant="secondary" href="/">
            Ir pra home
          </DsButton>
        }
      >
        Cole a URL de um produto na home pra gerar sua primeira landing.
      </EmptyBlock>
    );
  } else {
    content = (
      <s-stack gap="base">
        {/* Grade de cartões (pedido do owner: "gostava dos quadrados") com a prévia da página no topo. */}
        <s-grid gridTemplateColumns={LANDING_GRID_COLUMNS} gap="base" data-testid="landings-list">
          {items.map((landing) => (
            <LandingCard
              key={landing.id}
              landing={landing}
              onOpen={(id) => router.push(`/landing-pages/${id}/editor`)}
              onDelete={(l) => {
                feedback.dismiss();
                setDeleteTarget(l);
              }}
            />
          ))}
        </s-grid>
        {total > PAGE_SIZE ? <DsPagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} summary="range" noun={plural(total, 'landing')} /> : null}
      </s-stack>
    );
  }

  return (
    <PolarisGate>
      <s-page>
        <DsPageHeader
          title="Minhas landings"
          primaryAction={
            <DsButton variant="primary" href="/">
              Nova landing
            </DsButton>
          }
        />
        <s-stack gap="base">
          <ActionFeedback feedback={feedback.feedback} onDismiss={feedback.dismiss} />
          <s-section>
            <s-query-container>
              <s-grid gridTemplateColumns="@container (inline-size > 640px) 2fr 1fr auto, 1fr" gap="base" alignItems="end">
                <DsSearchField
                  id="landings-search"
                  label="Buscar landings"
                  labelHidden
                  placeholder="Buscar por título ou slug..."
                  value={query}
                  onChange={changeQuery}
                  onClear={() => setDebouncedQuery('')}
                />
                <DsSelect
                  id="landings-status"
                  label="Status"
                  value={status}
                  options={STATUS_OPTIONS}
                  onChange={(v) => {
                    setStatus(v as StatusFilter);
                    setPage(1);
                  }}
                />
                <div className="ds-live-region" role="status" aria-live="polite" data-testid="landings-count">
                  {list.status === 'ready' && total > 0 ? <s-text color="subdued">{countLabel(total)}</s-text> : null}
                </div>
              </s-grid>
            </s-query-container>
          </s-section>
          {content}
        </s-stack>
      </s-page>

      <ConfirmModal
        open={deleteTarget !== null}
        title="Excluir landing?"
        confirmLabel="Excluir"
        destructive
        loading={isDeleting}
        onConfirm={() => void handleConfirmDelete()}
        onClose={() => {
          if (!isDeleting) setDeleteTarget(null);
        }}
      >
        <s-paragraph>
          Vai excluir permanentemente{' '}
          <s-text type="strong" fontWeight="bold">
            &quot;{deleteTarget?.title ?? ''}&quot;
          </s-text>
          . Todos os dados de geração IA (copy, visual, HTML) também serão apagados. Ação irreversível.
        </s-paragraph>
      </ConfirmModal>
    </PolarisGate>
  );
}

export default function LandingPagesListPage(): JSX.Element {
  return (
    <Suspense>
      <LandingPagesContent />
    </Suspense>
  );
}

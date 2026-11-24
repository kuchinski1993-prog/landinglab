'use client';

// @ds-migrated — Story 20.10b (PR2): seção "Histórico" no design system.
//
// HistorySection — Timeline de versões da landing (Wave B, expansão do editor).
//
// Card colapsado por default; ao expandir, busca /api/landing-pages/[id]/history
// e renderiza lista cronológica reversa (snapshots do html_body + deployments).
//
// Só visual: a busca e os estados são os de antes; os ícones-emoji do tipo saíram (o rótulo já diz
// "Publicado…"/"Despublicado…"/snapshot) e o tamanho da mudança usa o tom do DS (verde cresce, vermelho
// encolhe).

import { useCallback, useEffect, useState } from 'react';

import { EditorCardHeader } from '../_components/EditorCard';

import { DsButton } from '@/components/ds';
import type { LandingPageRow } from '@/lib/landing-types';

interface Props {
  landing: LandingPageRow;
}

interface HistoryEvent {
  id: string;
  type: 'snapshot' | 'deployment';
  label: string;
  actor: string;
  bytes?: number;
  /** Diff bytesAfter - bytes; positivo cresceu, negativo encolheu. */
  changeSize?: number;
  hostname?: string;
  createdAt: string;
}

function formatChangeSize(delta: number): { text: string; tone: 'success' | 'critical' | undefined } {
  const sign = delta > 0 ? '+' : '';
  return {
    text: `${sign}${delta} bytes`,
    tone: delta > 0 ? 'success' : delta < 0 ? 'critical' : undefined,
  };
}

const MAX_VISIBLE = 20;

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function HistorySection({ landing }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`/api/landing-pages/${landing.id}/history`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      const data = (await res.json()) as {
        ok: boolean;
        events?: HistoryEvent[];
        message?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.message ?? 'Falha ao carregar histórico.');
        return;
      }
      setEvents(data.events ?? []);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Timeout ao carregar histórico. Tente novamente.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, [landing.id]);

  // Story 20.10e — com erro não busca de novo sozinho (antes: laço enquanto a rota
  // falhasse, porque a lista seguia null); só pelo "Tentar novamente".
  useEffect(() => {
    if (expanded && events === null && !loading && !error) {
      void fetchHistory();
    }
  }, [expanded, events, loading, error, fetchHistory]);

  const visibleEvents = events?.slice(0, MAX_VISIBLE) ?? [];
  const hasMore = (events?.length ?? 0) >= MAX_VISIBLE;


  return (
    <s-section>
      <s-stack gap="base">
        <EditorCardHeader
          title="Histórico"
          action={
            <DsButton variant="secondary" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Ocultar' : 'Ver histórico'}
            </DsButton>
          }
        />

        {expanded && (
          <s-stack gap="small-200">
            {loading && (
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-spinner size="base" accessibilityLabel="Carregando histórico" />
                <s-text color="subdued">Carregando histórico…</s-text>
              </s-stack>
            )}

            {!loading && error && (
              <s-stack gap="small-200">
                <div role="alert">
                  <s-text tone="critical">{error}</s-text>
                </div>
                <s-stack direction="inline">
                  <DsButton variant="secondary" onClick={() => void fetchHistory()}>
                    Tentar novamente
                  </DsButton>
                </s-stack>
              </s-stack>
            )}

            {!loading && !error && events !== null && visibleEvents.length === 0 && (
              <s-paragraph color="subdued">Nenhum histórico ainda.</s-paragraph>
            )}

            {!loading && !error && visibleEvents.length > 0 && (
              <s-stack gap="small-200">
                {visibleEvents.map((event) => {
                  const change =
                    typeof event.changeSize === 'number' && event.changeSize !== 0
                      ? formatChangeSize(event.changeSize)
                      : null;
                  return (
                    <s-stack key={event.id} gap="small-100">
                      <s-text>
                        <s-text type="strong" fontWeight="bold">
                          {event.label}
                        </s-text>
                        {change && (
                          <>
                            {' '}
                            <s-text tone={change.tone}>{change.text}</s-text>
                          </>
                        )}
                      </s-text>
                      <s-text color="subdued">
                        {formatDate(event.createdAt)} · {event.actor}
                        {typeof event.bytes === 'number' && <> · {(event.bytes / 1024).toFixed(1)} KB</>}
                      </s-text>
                    </s-stack>
                  );
                })}
                {hasMore && <s-paragraph color="subdued">Mostrando os {MAX_VISIBLE} eventos mais recentes.</s-paragraph>}
              </s-stack>
            )}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

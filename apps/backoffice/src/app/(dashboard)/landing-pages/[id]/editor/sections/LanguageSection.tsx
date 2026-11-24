'use client';

// @ds-migrated — Story 20.10b (PR2): seção "Idioma & Tradução" no design system.
//
// LanguageSection — Idioma & Tradução (Wave A #2, funcional).
//
// Fluxo:
//   - Card fechado: mostra idioma atual + timestamp última tradução + custo (se houver)
//   - Botão "Editar" abre inline (não modal) com Select de idiomas + botão Traduzir
//   - Confirmar → POST /api/translate-landing (worker processa em ~5min)
//   - Poll GET /api/translation-status a cada 2s enquanto ativo
//   - Barra de progresso incremental (usa totalStrings/stringsTranslated do worker)
//
// Só visual: chamada, polling (2 s, teto de 15 min), percentuais e avisos iguais a antes.

import { useCallback, useEffect, useRef, useState } from 'react';

import { EditorCardHeader } from '../_components/EditorCard';

import { DsButton, DsSelect } from '@/components/ds';
import type { LandingPageRow } from '@/lib/landing-types';

interface Props {
  landing: LandingPageRow;
  onLandingUpdate: (patch: Partial<LandingPageRow>) => void;
  onBanner: (
    tone: 'success' | 'critical' | 'info' | 'warning',
    message: string,
    title?: string,
  ) => void;
}

const LANGUAGES: Array<{ label: string; value: string }> = [
  { label: 'Português BR (pt-BR)', value: 'pt-BR' },
  { label: 'Inglês (en)', value: 'en' },
  { label: 'Italiano (it)', value: 'it' },
  { label: 'Espanhol (es)', value: 'es' },
  { label: 'Alemão (de)', value: 'de' },
  { label: 'Francês (fr)', value: 'fr' },
  { label: 'Japonês (ja)', value: 'ja' },
  { label: 'Chinês (zh)', value: 'zh' },
];

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 15 * 60 * 1000; // 15min hard timeout

interface PollResult {
  translationStatus: string;
  translationProgress: Record<string, unknown>;
  isActive: boolean;
}

export default function LanguageSection({
  landing,
  onLandingUpdate,
  onBanner,
}: Props): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [selectedLang, setSelectedLang] = useState<string>(
    landing.targetLanguage ?? 'pt-BR',
  );
  const [isEnqueuing, setIsEnqueuing] = useState(false);
  const [progress, setProgress] = useState<{
    status: string;
    stringsTranslated?: number;
    totalStrings?: number;
    costUsd?: number;
  }>({ status: landing.translationStatus });
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  const isTranslating =
    progress.status === 'text_pending' ||
    progress.status === 'text_running' ||
    progress.status === 'images_pending' ||
    progress.status === 'images_running';

  const isDone = progress.status === 'done' || progress.status === 'done_with_warnings';

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (!isMountedRef.current) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const res = await fetch(
        `/api/translation-status?landingId=${encodeURIComponent(landing.id)}`,
        { cache: 'no-store', signal: controller.signal },
      );
      if (!isMountedRef.current) return;
      if (!res.ok) return;
      const data = (await res.json()) as { ok: boolean } & Partial<PollResult>;
      if (!isMountedRef.current) return;
      if (!data.ok) return;

      const tp = data.translationProgress ?? {};
      setProgress({
        status: data.translationStatus ?? 'idle',
        stringsTranslated: tp['stringsTranslated'] as number | undefined,
        totalStrings: tp['totalStrings'] as number | undefined,
        costUsd: tp['costUsd'] as number | undefined,
      });

      if (data.translationStatus === 'done' || data.translationStatus === 'done_with_warnings') {
        if (isMountedRef.current) {
          onLandingUpdate({
            translationStatus: data.translationStatus,
            targetLanguage: selectedLang as LandingPageRow['targetLanguage'],
          });
          onBanner('success', `Tradução concluída em ${LANGUAGES.find((l) => l.value === selectedLang)?.label ?? selectedLang}.`);
        }
        stopPolling();
      } else if (data.translationStatus === 'failed') {
        if (isMountedRef.current) onBanner('critical', 'Falha na tradução. Tente de novo.');
        stopPolling();
      }

      if (Date.now() - pollStartRef.current > MAX_POLL_MS) {
        stopPolling();
        if (isMountedRef.current) {
          onBanner('critical', 'Timeout — tradução demorou mais de 15min sem terminar.');
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // outros erros: silêncio — próximo tick tenta
    }
  }, [landing.id, selectedLang, onLandingUpdate, onBanner, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollStartRef.current = Date.now();
    void poll();
    pollTimerRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
  }, [poll, stopPolling]);

  // Se landing já está em estado ativo ao montar, começa polling imediato
  useEffect(() => {
    isMountedRef.current = true;
    if (isTranslating) startPolling();
    return () => {
      isMountedRef.current = false;
      stopPolling();
    };
  }, []);

  const handleTranslate = useCallback(async () => {
    if (!selectedLang) return;
    setIsEnqueuing(true);
    try {
      const res = await fetch('/api/translate-landing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          landingId: landing.id,
          targetLanguage: selectedLang,
          sourceLanguage: 'auto',
        }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string };
      if (!res.ok || !data.ok) {
        onBanner('critical', data.message ?? 'Falha ao enfileirar tradução.');
        return;
      }
      onBanner(
        'info',
        `Tradução para ${LANGUAGES.find((l) => l.value === selectedLang)?.label ?? selectedLang} iniciada. Você pode continuar navegando — atualização em tempo real.`,
      );
      setEditing(false);
      setProgress({ status: 'text_pending' });
      startPolling();
    } catch (err) {
      onBanner('critical', err instanceof Error ? err.message : String(err));
    } finally {
      setIsEnqueuing(false);
    }
  }, [selectedLang, landing.id, onBanner, startPolling]);

  const percent = (() => {
    if (isDone) return 100;
    if (progress.status === 'starting' || progress.status === 'text_pending') return 5;
    if (progress.status === 'text_running') {
      const done = progress.stringsTranslated ?? 0;
      const total = progress.totalStrings ?? 0;
      if (total > 0) return 10 + Math.round((done / total) * 60);
      return 15;
    }
    if (progress.status === 'images_running') return 80;
    return 0;
  })();

  const currentLangLabel = LANGUAGES.find((l) => l.value === (landing.targetLanguage ?? 'auto'))?.label
    ?? landing.targetLanguage
    ?? '(não traduzida)';


  return (
    <s-section>
      <s-stack gap="base">
        <EditorCardHeader
          title="Idioma & Tradução"
          badges={
            <>
              {isDone && landing.translationStatus === 'done_with_warnings' && <s-badge tone="caution">Concluída com avisos</s-badge>}
              {isDone && landing.translationStatus === 'done' && <s-badge tone="success">Traduzida</s-badge>}
              {isTranslating && <s-badge tone="info">Traduzindo…</s-badge>}
            </>
          }
          action={
            !editing && !isTranslating ? (
              <DsButton variant="secondary" onClick={() => setEditing(true)}>
                Editar
              </DsButton>
            ) : null
          }
        />

        {!editing && !isTranslating && (
          <s-paragraph color="subdued">
            Idioma atual:{' '}
            <s-text type="strong" fontWeight="bold">
              {currentLangLabel}
            </s-text>
            {progress.stringsTranslated != null && progress.stringsTranslated > 0 && (
              <>
                {' '}· {progress.stringsTranslated} strings
                {progress.costUsd != null && progress.costUsd > 0 && <> · custo ${progress.costUsd.toFixed(4)}</>}
              </>
            )}
          </s-paragraph>
        )}

        {editing && (
          <s-stack gap="base">
            <s-paragraph color="subdued">
              Escolha o idioma alvo. A tradução é feita pelo Anthropic Haiku
              (custo ~$0.005/landing). Leva ~5min pra landings médias.
            </s-paragraph>
            <s-box maxInlineSize="320px">
              <DsSelect label="Idioma alvo" options={LANGUAGES} value={selectedLang} onChange={setSelectedLang} disabled={isEnqueuing} />
            </s-box>
            <s-stack direction="inline" gap="small-200">
              <DsButton
                variant="secondary"
                onClick={handleTranslate}
                loading={isEnqueuing}
                disabled={isEnqueuing || selectedLang === (landing.targetLanguage ?? '')}
              >
                Traduzir agora
              </DsButton>
              <DsButton variant="tertiary" onClick={() => setEditing(false)} disabled={isEnqueuing}>
                Cancelar
              </DsButton>
            </s-stack>
          </s-stack>
        )}

        {isTranslating && (
          <div aria-live="polite">
            <s-stack gap="small-200">
              <s-stack direction="inline" justifyContent="space-between" gap="base">
                <s-text>
                  Traduzindo texto…
                  {progress.totalStrings && progress.stringsTranslated != null && (
                    <> ({progress.stringsTranslated}/{progress.totalStrings} strings)</>
                  )}
                </s-text>
                <s-text color="subdued">{`${percent}%`}</s-text>
              </s-stack>
              <s-progress value={percent} max={100} accessibilityLabel="Progresso da tradução" />
              <s-paragraph color="subdued">Pode fechar essa aba e voltar depois — a tradução continua rodando.</s-paragraph>
            </s-stack>
          </div>
        )}
      </s-stack>
    </s-section>
  );
}

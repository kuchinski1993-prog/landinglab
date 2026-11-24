'use client';

// @ds-migrated — Story 20.10b (PR2): casca do editor da landing no design system.
//
// Editor Panel — substitui Wizard V2. Wave A (set/2026).
//
// UX: painel de edição não-sequencial com seções independentes editáveis.
// Cada seção é auto-contida; usuário edita o que quiser, salva, publica.
//
// Seções condicionais por landing_kind:
//   - Todos: Idioma, CTAs, Publicação
//   - Sales_page ONLY: Imagens Produto, Bundles, Preços
//   - Advertorial esconde as 3 exclusivas de sales_page
//
// Story 20.10b — só visual: o polling da clonagem (5 s, até 120 tentativas), o reclone, a atualização
// local da landing e a ordem/condição das seções são os de antes, linha a linha. Mudou: cabeçalho do DS
// (`DsPageHeader`: título 26px/700, "Publicar"/"Republicar" sem emoji — rola até a publicação e move o
// foco para ela — e "Preview do rascunho"/"Ver ao vivo" em nova aba na mesma linha), voltar "Landings"
// acima do título, avisos `s-banner`, cartões `s-section`.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import SubsConfig from '../SubsConfig';

import { EditorBanner } from './_components/EditorCard';
import BundlesSection from './sections/BundlesSection';
import CheckoutSection from './sections/CheckoutSection';
import CtasSection from './sections/CtasSection';
import DomainsSection from './sections/DomainsSection';
import HistorySection from './sections/HistorySection';
import LanguageSection from './sections/LanguageSection';
import PriceSection from './sections/PriceSection';
import ProductImagesSection from './sections/ProductImagesSection';
import PublishSection from './sections/PublishSection';

import { DsButton, DsPageHeader, PolarisGate, isModifiedClick } from '@/components/ds';
import OperationsStatus from '@/components/landing/OperationsStatus';
import PreviewInfoBanner from '@/components/landing/PreviewInfoBanner';
import { deriveCloneLifecycle, isLegacyManualLanding } from '@/lib/clone-lifecycle';
import type { LandingPageRow } from '@/lib/landing-types';

const LIST_HREF = '/landing-pages';

function BackLink(): JSX.Element {
  const router = useRouter();
  return (
    <s-link
      href={LIST_HREF}
      onClick={(event) => {
        if (isModifiedClick(event as unknown as MouseEvent)) return;
        event.preventDefault();
        router.push(LIST_HREF);
      }}
    >
      Landings
    </s-link>
  );
}

/** Rola até a seção de publicar e move o foco para ela (leitor de tela e teclado chegam junto). */
function goToPublish(): void {
  const section = document.getElementById('publish-section');
  if (!section) return;
  section.scrollIntoView({ behavior: 'smooth' });
  if (!section.hasAttribute('tabindex')) section.setAttribute('tabindex', '-1');
  section.focus({ preventScroll: true });
}

interface Props {
  landing: LandingPageRow;
}

// Polling: máximo 10 minutos (120 * 5s) — evita loop infinito se worker travou.
const CLONE_POLL_INTERVAL_MS = 5_000;
const CLONE_POLL_MAX_ATTEMPTS = 120;

export default function EditorPanel({ landing: initialLanding }: Props): JSX.Element {
  const [landing, setLanding] = useState<LandingPageRow>(initialLanding);
  const [globalBanner, setGlobalBanner] = useState<{
    tone: 'success' | 'critical' | 'info' | 'warning';
    title?: string;
    message: string;
  } | null>(null);
  const [reclonePending, setReclonePending] = useState(false);

  const isAdvertorial = landing.landingKind === 'advertorial';
  const isPublished = landing.status === 'published';
  const isLegacy = isLegacyManualLanding(landing.generationMode, landing.cloneMetadata);

  // Lifecycle de clonagem — bloqueia editor quando clonando/falhou (SB-03).
  const cloneLifecycle = deriveCloneLifecycle(
    landing.generationMode,
    landing.cloneMetadata,
    landing.clonedAt,
    landing.htmlBody,
  );
  const isCloneBlocked = cloneLifecycle.isBlocked;
  const shouldPoll =
    cloneLifecycle.status === 'cloning' || cloneLifecycle.status === 'processing';

  // Auto-polling — enquanto worker está trabalhando, ping /status a cada 5s.
  // Quando lifecycle sai de cloning/processing → reload pra puxar estado fresh
  // do server (mais simples que reconciliar cloneMetadata client-side).
  const pollAttemptRef = useRef(0);
  useEffect(() => {
    if (!shouldPoll) {
      pollAttemptRef.current = 0;
      return;
    }
    let cancelled = false;
    const controller = new AbortController();

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      pollAttemptRef.current += 1;
      if (pollAttemptRef.current > CLONE_POLL_MAX_ATTEMPTS) {
        // Silencioso: usuário pode F5 manualmente. Log só pra debug.
        console.warn('[EditorPanel] clone polling timeout (10min)');
        return;
      }
      try {
        const res = await fetch(`/api/landing-pages/${landing.id}/status`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          ok: boolean;
          cloneMetadata?: Record<string, unknown> | null;
          clonedAt?: string | null;
          translationStatus?: string;
        };
        if (!data.ok) return;
        const nextLifecycle = deriveCloneLifecycle(
          landing.generationMode,
          data.cloneMetadata ?? null,
          data.clonedAt ?? null,
          landing.htmlBody,
        );
        const wasBlocked =
          cloneLifecycle.status === 'cloning' || cloneLifecycle.status === 'processing';
        const nowReady = nextLifecycle.status === 'ready' || nextLifecycle.status === 'failed';
        if (wasBlocked && nowReady) {
          window.location.reload();
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Silencioso — polling é best effort, próxima tentativa cobre.
      }
    };

    const interval = setInterval(() => {
      void tick();
    }, CLONE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [
    shouldPoll,
    landing.id,
    landing.generationMode,
    landing.htmlBody,
    cloneLifecycle.status,
  ]);

  const handleReclone = useCallback(async () => {
    if (reclonePending) return;
    if (!landing.sourceUrl && !landing.htmlBody) {
      setGlobalBanner({
        tone: 'critical',
        message:
          'Landing sem sourceUrl — abra "Editar configurações" pra fornecer a URL antes de reclonar.',
      });
      return;
    }
    setReclonePending(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch('/api/clone-landing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          landingId: landing.id,
          url: landing.sourceUrl ?? 'https://placeholder.local/manual-paste',
        }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; jobId?: string };
      if (!res.ok || !data.ok) {
        setGlobalBanner({
          tone: 'critical',
          message: data.message ?? `HTTP ${res.status}`,
          title: 'Falha ao iniciar reclone',
        });
        return;
      }
      setGlobalBanner({
        tone: 'info',
        message: 'Reclone enfileirado. A página vai recarregar quando terminar.',
        title: 'Reclone iniciado',
      });
      // Optimistic: força cloneMetadata pra reativar polling.
      setLanding((prev) => ({
        ...prev,
        cloneMetadata: { clone_status: 'cloning', queued_at: new Date().toISOString() },
      }));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setGlobalBanner({
          tone: 'critical',
          message: 'Timeout ao enfileirar reclone. Tente novamente.',
        });
      } else {
        setGlobalBanner({
          tone: 'critical',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      clearTimeout(timeout);
      setReclonePending(false);
    }
  }, [landing.id, landing.sourceUrl, landing.htmlBody, reclonePending]);

  // Callback usado por sub-seções pra atualizar campos da landing sem refetch.
  // Ex: LanguageSection atualiza translationStatus após dispatch; PublishSection
  // atualiza status='published' + publishedAt.
  const updateLandingFields = (patch: Partial<LandingPageRow>): void => {
    setLanding((prev) => ({ ...prev, ...patch }));
  };

  const showGlobalBanner = (
    tone: 'success' | 'critical' | 'info' | 'warning',
    message: string,
    title?: string,
  ): void => {
    setGlobalBanner({ tone, message, ...(title ? { title } : {}) });
  };


  // Quando clone está bloqueado, mostra tela de estado em vez do editor completo.
  if (isCloneBlocked) {
    const isFailed = cloneLifecycle.status === 'failed';
    return (
      <PolarisGate>
        <s-page>
          <DsPageHeader title={landing.title || 'Landing sem título'} breadcrumb={<BackLink />} />
          <s-stack gap="base">
            <EditorBanner tone={isFailed ? 'critical' : 'info'} title={isFailed ? 'Falha no clone' : 'Clonagem em andamento'}>
              {isFailed ? (
                <s-stack gap="small-200">
                  <s-paragraph>
                    O processo de clonagem falhou e este editor não está disponível.
                    {cloneLifecycle.errorMessage && (
                      <>
                        {' '}Erro:{' '}
                        <s-text type="strong" fontWeight="bold">
                          {cloneLifecycle.errorMessage}
                        </s-text>
                      </>
                    )}
                  </s-paragraph>
                  <s-stack direction="inline" gap="small-200">
                    <DsButton variant="primary" onClick={handleReclone} loading={reclonePending} disabled={reclonePending}>
                      Tentar novamente
                    </DsButton>
                    <DsButton variant="secondary" href={`/landing-pages/${landing.id}/edit`}>
                      Editar configurações de clone
                    </DsButton>
                  </s-stack>
                </s-stack>
              ) : (
                <s-stack gap="small-200">
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-spinner size="base" accessibilityLabel="Clonando" />
                    <s-text>A landing está sendo clonada. Isso leva entre 30s e 2min.</s-text>
                  </s-stack>
                  <s-paragraph>
                    Esta página vai recarregar automaticamente quando a clonagem terminar
                    (verificação a cada 5s).
                  </s-paragraph>
                </s-stack>
              )}
            </EditorBanner>
            <s-stack direction="inline">
              <DsButton variant="secondary" href="/landing-pages">
                Voltar para Landings
              </DsButton>
            </s-stack>
          </s-stack>
        </s-page>
      </PolarisGate>
    );
  }

  const kindLabel =
    landing.landingKind === 'unknown' ? 'Tipo não classificado' : landing.landingKind === 'advertorial' ? 'Advertorial' : 'Página de vendas';

  return (
    <PolarisGate>
      <s-page>
        <DsPageHeader
          title={landing.title || 'Landing sem título'}
          breadcrumb={<BackLink />}
          primaryAction={
            // P1: continua só levando à seção de publicar (nenhum publicar acidental).
            <DsButton variant="primary" onClick={goToPublish}>
              {isPublished ? 'Republicar' : 'Publicar em Blackshop'}
            </DsButton>
          }
          secondaryActions={[
            // Epic 26: editor visual (seções, botões, preços, textos e imagens direto na página).
            <DsButton key="visual" variant="secondary" href={`/landing-pages/${landing.id}/edit`}>
              Editar visualmente
            </DsButton>,
            <DsButton key="preview" variant="secondary" href={`/landing-pages/${landing.id}/preview`} target="_blank">
              {landing.status === 'published' ? 'Ver ao vivo' : 'Preview do rascunho'}
            </DsButton>,
          ]}
        />
        <s-stack gap="base">
          <s-paragraph color="subdued">{`${kindLabel} · ${landing.slug}`}</s-paragraph>

          <PreviewInfoBanner landing={landing} />

          {globalBanner && (
            <EditorBanner tone={globalBanner.tone} title={globalBanner.title} onDismiss={() => setGlobalBanner(null)}>
              {globalBanner.message}
            </EditorBanner>
          )}

          {isLegacy && (
            <EditorBanner tone="warning" title="Legacy / Manual landing">
              Esta landing não foi criada pelo pipeline atual de clonagem.
              O HTML pode conter assets e scripts legados.
              Preview e publicação continuam disponíveis.
            </EditorBanner>
          )}

          {/* Status header: clone lifecycle | fidelity | translation | publish.
              Reutiliza deriveCloneLifecycle + parseFidelityFromCloneMetadata —
              estados "normais" ficam ocultos pra não poluir. Publish gate real
              vive em publish-core.publishLandingCore (BLOCKED → 400 sem override). */}
          <OperationsStatus landing={landing} />

          {landing.landingKind === 'unknown' && (
            <EditorBanner tone="warning" title="Tipo não classificado">
              Essa landing não foi classificada como advertorial ou página de vendas.
              Seções específicas de sales_page (Preços, Bundles, Imagens Produto)
              aparecem mesmo assim. Novos clones pedem esse tipo antes.{' '}
              <s-link href={`/landing-pages/${landing.id}/edit`}>Editar tipo</s-link>
            </EditorBanner>
          )}

          {/* Seção 1 — Idioma & Tradução (todos os tipos) */}
          <LanguageSection landing={landing} onLandingUpdate={updateLandingFields} onBanner={showGlobalBanner} />

          {/* Histórico de versões (snapshots + deployments) */}
          <HistorySection landing={landing} />

          {/* Seção 2 — CTAs (todos os tipos) — FUNCIONAL Wave B */}
          <CtasSection landing={landing} onBanner={showGlobalBanner} />

          {/* Seções condicionais de sales_page */}
          {!isAdvertorial && (
            <>
              <ProductImagesSection landing={landing} onBanner={showGlobalBanner} />
              <BundlesSection landing={landing} onBanner={showGlobalBanner} />
              <SubsConfig
                key={`subs-${landing.checkoutProvider}`}
                landingPageId={landing.id}
                shopifyProductGid={landing.shopifyProductGid ?? null}
                checkoutProvider={landing.checkoutProvider}
              />
              <PriceSection landing={landing} onLandingUpdate={updateLandingFields} onBanner={showGlobalBanner} />
              {/* Story 15.2 — mercado (idioma/moeda/frete) + Shopify | Stripe */}
              <CheckoutSection landing={landing} onLandingUpdate={updateLandingFields} onBanner={showGlobalBanner} />
            </>
          )}

          {isAdvertorial && (
            <s-section>
              <s-stack gap="small-200">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-heading>Advertorial simplificado</s-heading>
                  <s-badge tone="info">landing_kind=advertorial</s-badge>
                </s-stack>
                <s-paragraph color="subdued">
                  Seções de Preços, Bundles e Imagens Produto estão ocultas
                  porque advertoriais não precisam delas. Se você marcou o tipo
                  errado, edite abaixo.
                </s-paragraph>
                <s-stack direction="inline">
                  <DsButton variant="secondary" href={`/landing-pages/${landing.id}/edit`}>
                    Editar tipo da landing
                  </DsButton>
                </s-stack>
              </s-stack>
            </s-section>
          )}

          {/* Seção 5 — Domínios (discovery + link pro publish) */}
          <DomainsSection landing={landing} onBanner={showGlobalBanner} />

          {/* Seção 6 — Publicação (todos os tipos, funcional) */}
          <PublishSection landing={landing} onLandingUpdate={updateLandingFields} onBanner={showGlobalBanner} />
        </s-stack>
      </s-page>
    </PolarisGate>
  );
}

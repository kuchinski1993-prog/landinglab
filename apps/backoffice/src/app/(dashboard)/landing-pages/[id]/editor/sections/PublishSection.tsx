'use client';

// @ds-migrated — Story 20.10b (PR3): seção "Publicação" no design system.
//
// PublishSection — Publicação end-to-end (Wave B + Shopify).
//
// 1 botão "Publicar" faz TUDO:
//   Passo 1/2 — Cria produto Shopify com variants = bundles offers
//               (salva variantIds em landing_bundle_offers pro CTA redirect)
//   Passo 2/2 — Publica landing Blackshop (subdomain do domínio escolhido)
//
// Story 0.6: o passo Blackshop usa o publicador único — só vira "publicada"
// quando a Vercel aceitou e o HTTPS responde. Se o checkout não estiver pronto
// (ex.: Shopify falhou e as ofertas ficaram sem variante), a publicação é
// recusada com o checklist; DNS/SSL pendente mostra "Verificar novamente".
//
// Checkout Stripe (E2E B-1): NÃO chama publish-shopify (nada de produto
// Shopify nem regravar variantId das ofertas) e republica no host REAL da
// landing (binding ativo, ex.: chemistry-club.cubipiccanti.online) — não no
// slug interno do clone. O servidor recusa publish-shopify para Stripe.
//
// Seletor de domínio: lê /api/landing-domains/list (só ativos).
// Input slug: preview do subdomínio final em tempo real.
//
// Story 20.10b — só visual: publicar (Shopify → Blackshop), verificar, auto-verificação, despublicar e
// reclone são os de antes, linha a linha. O botão de publicar é o primário REAL da ação (o do cabeçalho
// só traz até aqui). `LandingPublishChecklist` (fora do editor) continua em Polaris React.

import { useCallback, useEffect, useState, useTransition } from 'react';

import { EditorBanner, EditorCardHeader } from '../_components/EditorCard';

import ExportPackages from './ExportPackages';

import {
  fetchDeploymentStatus,
  getLiveLandingHost,
  publishLandingPage,
  unpublishLandingPage,
} from '@/app/(dashboard)/landing-pages/[id]/publish-actions';
import LandingPublishChecklist from '@/app/(dashboard)/landing-pages/[id]/LandingPublishChecklist';
import {
  loadPublishCheck,
  verifyPublication,
  type PublishApiPayload,
} from '@/app/(dashboard)/landing-pages/[id]/publish-client';
import { useAutoVerify } from '@/app/(dashboard)/landing-pages/[id]/use-auto-verify';
import { DsButton, DsSelect, DsTextField } from '@/components/ds';
import { parseFidelityFromCloneMetadata } from '@/lib/fidelity-badge';
import type { LandingPublishCheckItem } from '@/lib/landing-publish-check';
import { isLiveSelection, type LiveHost } from '@/lib/landing-live-host';
import type { LandingPageRow } from '@/lib/landing-types';
import { normalizeSlug, validateAndNormalizeSlug } from '@/lib/slug-utils';

interface Props {
  landing: LandingPageRow;
  onLandingUpdate: (patch: Partial<LandingPageRow>) => void;
  onBanner: (
    tone: 'success' | 'critical' | 'info' | 'warning',
    message: string,
    title?: string,
  ) => void;
}

// Map de findings do fidelity gate → label amigável. Fonte dos identifiers:
// packages/landinglab-cloner/src/orchestrator.ts (assessCloneFidelity).
// Findings vêm no formato `${SEVERITY}:${kind}(${meta})` — a chave desse map
// é a raiz `kind`; parseFindingKey abaixo remove severity + parâmetros.
const FINDING_LABELS: Record<string, string> = {
  'non-frozen-script-refs': 'Scripts externos não congelados (podem mudar)',
  'duplicate-script-refs': 'Scripts duplicados detectados',
  'unresolved-asset-placeholders': 'URLs de assets não resolvidos',
  'low-asset-success-rate': 'Taxa de download de assets abaixo do esperado',
  'chrome-extension-refs': 'Referências a extensões de browser (crítico)',
  'browser-extension-artifact': 'Artefato de extensão de browser detectado (crítico)',
  'critical-css-missing': 'CSS crítico ausente (crítico)',
};

/**
 * Extrai a chave canônica de um finding do cloner.
 * Exemplos:
 *   'DEGRADED:non-frozen-script-refs(3)' → 'non-frozen-script-refs'
 *   'BLOCKED:critical-css-missing'       → 'critical-css-missing'
 *   'unknown-string'                      → 'unknown-string'
 */
function parseFindingKey(raw: string): string {
  const withoutSeverity = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
  return withoutSeverity.replace(/\([^)]*\)$/, '').trim();
}

interface Domain {
  id: string;
  domain: string;
  role: string;
}

interface PublishStep {
  id: 'shopify' | 'blackshop';
  label: string;
  status: 'pending' | 'running' | 'done' | 'waiting' | 'failed' | 'skipped';
  message?: string;
}

export default function PublishSection({
  landing,
  onLandingUpdate,
  onBanner,
}: Props): JSX.Element {
  const isAdvertorial = landing.landingKind === 'advertorial';
  const isPublished = landing.status === 'published';
  // Stripe: publicação sem Shopify (o checkout é próprio).
  const isStripe = landing.checkoutProvider === 'stripe';
  // Story 16.3: checkout externo (do produtor) também não passa pela Shopify.
  const isExternal = landing.checkoutProvider === 'external';
  // LandingLab standalone: sem integração Shopify (a rota publish-shopify não faz parte deste repo).
  const skipShopify = true || isAdvertorial || isStripe || isExternal;

  // Fidelity: só clones passam pelo cloner+gate. DEGRADED = publica mas com
  // findings menores; BLOCKED já é bloqueado no server (publish-core → 400 sem
  // override), então UX aqui é só pra DEGRADED. HEALTHY/UNKNOWN sem banner.
  const fidelityInfo =
    landing.generationMode === 'cloned'
      ? parseFidelityFromCloneMetadata(landing.cloneMetadata)
      : null;
  const showDegradedBanner = fidelityInfo?.verdict === 'DEGRADED';

  const [domains, setDomains] = useState<Domain[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [selectedDomainId, setSelectedDomainId] = useState<string>('');
  const [slug, setSlug] = useState<string>(landing.slug || '');
  const [steps, setSteps] = useState<PublishStep[]>([]);
  const [publishedHostname, setPublishedHostname] = useState<string | null>(null);
  // Story 0.6 — publicação reservada mas ainda não no ar (SSL/DNS pendente ou
  // Vercel falhou): guarda o deployment para o "Verificar novamente".
  const [pendingPublish, setPendingPublish] = useState<
    { deploymentId: string; hostname: string; message: string; status?: string; code?: string } | null
  >(null);
  const [autoVerifyGaveUp, setAutoVerifyGaveUp] = useState(false);
  const [checkItems, setCheckItems] = useState<LandingPublishCheckItem[] | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isVerifying, setIsVerifying] = useState(false);
  const [isUnpublishing, setIsUnpublishing] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [isReclone, setIsReclone] = useState(false);
  const [liveHost, setLiveHost] = useState<LiveHost | null>(null);

  const selectedDomain = domains.find((d) => d.id === selectedDomainId);
  // Stripe: domínio/slug iguais aos do host vivo → republica nele (inclui raiz).
  const liveSelected = isStripe && isLiveSelection(liveHost, selectedDomainId, normalizeSlug(slug));
  const previewUrl = liveSelected && liveHost
    ? `https://${liveHost.hostname}`
    : selectedDomain && slug
      ? `https://${normalizeSlug(slug)}.${selectedDomain.domain}`
      : selectedDomain
        ? `https://${selectedDomain.domain}`
        : '(escolha um domínio)';

  // Stripe: pré-preenche domínio + slug com o host em que a landing está no ar.
  useEffect(() => {
    if (!isStripe) return;
    let cancelled = false;
    getLiveLandingHost(landing.id)
      .then((live) => {
        if (cancelled || !live) return;
        setLiveHost(live);
        setSelectedDomainId(live.domainId);
        setSlug(live.slug);
        setPublishedHostname((prev) => prev ?? live.hostname);
      })
      .catch(() => undefined); // sem host vivo → formulário normal
    return () => {
      cancelled = true;
    };
  }, [isStripe, landing.id]);

  // Story 0.6 (QA F3): depois de recarregar a página, recupera a publicação que
  // ficou pendente (aguardando SSL/DNS ou falha do publish-core) para o
  // "Verificar novamente" continuar visível.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => fetchDeploymentStatus(landing.id))
      .then((view) => {
        if (cancelled || !view?.deploymentId || !view.hostname) return;
        const fromCore = view.errorAgent === 'publish-core';
        const pending =
          view.deploymentStatus === 'awaiting_ssl' ||
          (fromCore && (view.deploymentStatus === 'provisioning' || view.deploymentStatus === 'publish_failed'));
        if (!pending) return;
        setPendingPublish((prev) =>
          prev ?? {
            deploymentId: view.deploymentId!,
            hostname: view.hostname!,
            message: view.errorReason ?? 'A publicação ainda não foi confirmada.',
            status: view.deploymentStatus ?? undefined,
            code: view.errorCode ?? undefined,
          },
        );
      })
      .catch(() => undefined); // sem status → só o formulário
    return () => {
      cancelled = true;
    };
  }, [landing.id]);

  // Checklist de checkout antes de publicar (Story 0.6). Só para quem não passa
  // pelo passo Shopify — nesse, o próprio botão cria as variantes que faltam.
  useEffect(() => {
    if (!skipShopify) return;
    let cancelled = false;
    void loadPublishCheck(landing.id).then((result) => {
      if (!cancelled && result?.ok && result.items) setCheckItems(result.items);
    });
    return () => {
      cancelled = true;
    };
  }, [skipShopify, landing.id]);

  // Fetch domínios ativos — AbortController previne spinner infinito (SB-01).
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setLoadingDomains(true);
    fetch('/api/landing-domains/list', { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { ok: boolean; domains?: Domain[] }) => {
        const active = (data.domains ?? []).filter(
          (d) => d.role === 'active' || d.role === 'pending_dns',
        );
        setDomains(active);
        // Functional update: não sobrescreve o host vivo (Stripe) já escolhido.
        if (active.length > 0) {
          setSelectedDomainId((prev) => prev || active[0].id);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') {
          onBanner('critical', 'Timeout ao carregar domínios. Recarregue a página.');
        } else {
          onBanner('critical', 'Falha ao listar domínios.');
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        setLoadingDomains(false);
      });
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const updateStep = useCallback((id: 'shopify' | 'blackshop', patch: Partial<PublishStep>) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const handlePublishAll = useCallback(() => {
    if (!selectedDomain) {
      onBanner('critical', 'Escolha um domínio.');
      return;
    }
    let targetHost: string;
    if (liveSelected && liveHost) {
      targetHost = liveHost.hostname;
    } else {
      const slugCheck = validateAndNormalizeSlug(slug);
      if (!slugCheck.ok) {
        onBanner('critical', slugCheck.error);
        return;
      }
      targetHost = `${slugCheck.normalized}.${selectedDomain.domain}`;
    }
    const targetSlug = targetHost.split('.')[0] ?? '';

    // Inicializa steps (sales_page tem 2 steps; advertorial e Stripe pulam Shopify)
    const initialSteps: PublishStep[] = skipShopify
      ? [{ id: 'blackshop', label: 'Publicar no Blackshop', status: 'pending' }]
      : [
          { id: 'shopify', label: 'Criar produto no Shopify', status: 'pending' },
          { id: 'blackshop', label: 'Publicar no Blackshop', status: 'pending' },
        ];
    setSteps(initialSteps);

    startTransition(async () => {
      let shopifyOk = true;

      // ── Passo 1: Shopify (só sales_page com checkout Shopify) ──────────
      if (!skipShopify) {
        updateStep('shopify', { status: 'running' });
        try {
          const res = await fetch(`/api/landing-pages/${landing.id}/publish-shopify`, {
            method: 'POST',
          });
          const data = (await res.json()) as {
            ok: boolean;
            message?: string;
            variantIdsAssigned?: number;
            productHandle?: string;
          };
          if (!res.ok || !data.ok) {
            shopifyOk = false;
            updateStep('shopify', {
              status: 'failed',
              message: data.message ?? `HTTP ${res.status}`,
            });
            onBanner(
              'warning',
              `Shopify falhou: ${data.message ?? 'erro desconhecido'}. A publicação vai conferir se os botões de compra estão prontos antes de colocar a landing no ar.`,
            );
          } else {
            updateStep('shopify', {
              status: 'done',
              message: `Produto criado: ${data.productHandle} · ${data.variantIdsAssigned} variantes mapeadas`,
            });
          }
        } catch (err) {
          shopifyOk = false;
          const msg = err instanceof Error ? err.message : String(err);
          updateStep('shopify', { status: 'failed', message: msg });
          onBanner('warning', `Shopify erro: ${msg}. A publicação vai conferir o checkout antes de colocar no ar.`);
        }
      }

      // ── Passo 2: Blackshop ────────────────────────────────────────────
      updateStep('blackshop', { status: 'running' });
      try {
        const result = await publishLandingPage(landing.id, 'custom_domain', targetHost);
        setCheckItems(result.checkItems ?? null);
        if (!result.ok) {
          const waiting = result.status === 'awaiting_ssl' || result.status === 'awaiting_dns';
          if (result.deploymentId && result.status !== 'rejected') {
            setAutoVerifyGaveUp(false);
            setPendingPublish({
              deploymentId: result.deploymentId,
              hostname: result.hostname ?? targetHost,
              message: result.message ?? '',
              status: result.status,
              ...(result.code ? { code: result.code } : {}),
            });
          }
          updateStep('blackshop', {
            status: waiting ? 'waiting' : 'failed',
            message: result.message ?? 'erro desconhecido',
          });
          onBanner(
            waiting ? 'warning' : 'critical',
            result.message ?? 'Falha ao publicar.',
            waiting ? 'Ainda não publicada' : 'Publicação não concluída',
          );
          return;
        }
        const hostname = result.hostname ?? targetHost;
        setPublishedHostname(hostname);
        setPendingPublish(null);
        if (result.warning) {
          // Republicação de endereço já no ar: continua publicada, reverificação falhou.
          updateStep('blackshop', { status: 'done', message: `No ar: https://${hostname} (reverificação pendente)` });
          onLandingUpdate({ status: 'published', publishedAt: new Date().toISOString() });
          onBanner('warning', result.message ?? 'Landing republicada.', 'Republicada com aviso');
          return;
        }
        updateStep('blackshop', {
          status: 'done',
          message: `Publicado com SSL: https://${hostname}`,
        });
        // Reenfileira apply-bundle pra garantir que o HTML publicado tem os bundle
        // offers mais recentes (o publish-core também enfileira; o worker deduplica).
        fetch(`/api/landing-pages/${landing.id}/recalc-prices`, { method: 'POST' })
          .catch(() => undefined); // best-effort, não bloqueia
        // Stripe: landing_pages.slug (identificador interno) não muda — o host
        // vivo pode ser a raiz do domínio ou um subdomínio diferente do slug.
        onLandingUpdate({
          status: 'published',
          publishedAt: new Date().toISOString(),
          ...(isStripe ? {} : { slug: targetSlug }),
        });
        onBanner(
          shopifyOk ? 'success' : 'warning',
          isStripe
            ? `Landing republicada em https://${hostname} com SSL ativo (checkout Stripe — nada foi alterado na Shopify).`
            : isExternal && !isAdvertorial
              ? `Landing publicada em https://${hostname} com SSL ativo (checkout externo — botões levam direto ao checkout do produtor; nada foi alterado na Shopify).`
              : isAdvertorial
              ? `Landing publicada em https://${hostname} com SSL ativo.`
              : shopifyOk
                ? `Landing publicada em https://${hostname} com SSL ativo e CTA redirecionando pro Shopify.`
                : `Landing publicada em https://${hostname}, mas a criação do produto na Shopify falhou — os botões passaram no checklist com as variantes que já existiam; confira-os.`,
          'Publicação concluída',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        updateStep('blackshop', { status: 'failed', message: msg });
        onBanner('critical', msg);
      }
    });
  }, [
    landing.id,
    selectedDomain,
    slug,
    skipShopify,
    isStripe,
    isExternal,
    isAdvertorial,
    liveSelected,
    liveHost,
    updateStep,
    onBanner,
    onLandingUpdate,
  ]);

  // Re-clone (DEGRADED remediation) — dispara POST /api/clone-landing com
  // { landingId, url } pra reutilizar a mesma row e reprocessar o clone
  // via worker. Ideal quando findings menores (non-frozen-script-refs,
  // duplicate-script-refs, unresolved-asset-placeholders) podem ser
  // resolvidos por um novo pass do cloner. Sem sourceUrl gravado → skip
  // (landing legacy sem origem armazenada; operator precisa reclone manual).
  const handleReclone = useCallback(async () => {
    const sourceUrl = landing.sourceUrl?.trim();
    if (!sourceUrl) {
      onBanner(
        'warning',
        'Esta landing não tem URL de origem gravada (clone antigo). Reclone manual pela tela de importação.',
      );
      return;
    }
    setIsReclone(true);
    try {
      const res = await fetch('/api/clone-landing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ landingId: landing.id, url: sourceUrl }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; jobId?: string };
      if (!res.ok || !data.ok) {
        onBanner('critical', data.message ?? `Falha ao enfileirar reclone (HTTP ${res.status}).`);
        return;
      }
      onBanner(
        'info',
        `Reclone enfileirado (job ${data.jobId ?? 'novo'}). O worker vai reprocessar em ~30-90s. Recarregue esta página em ~1min pra ver o novo verdict.`,
        'Reclone em andamento',
      );
      onLandingUpdate({ status: 'draft' });
    } catch (err) {
      onBanner('critical', err instanceof Error ? err.message : String(err));
    } finally {
      setIsReclone(false);
    }
  }, [landing.id, landing.sourceUrl, onBanner, onLandingUpdate]);

  // Resultado de "Verificar novamente" (manual ou automático).
  const applyVerifyResult = useCallback(
    (result: PublishApiPayload, opts: { quiet?: boolean } = {}) => {
      if (result.ok && result.status === 'published') {
        const host = result.hostname ?? pendingPublish?.hostname ?? '';
        setPublishedHostname(host);
        setPendingPublish(null);
        updateStep('blackshop', { status: 'done', message: `Publicado com SSL: https://${host}` });
        onLandingUpdate({ status: 'published', publishedAt: new Date().toISOString() });
        onBanner(result.warning ? 'warning' : 'success', result.message ?? 'Landing publicada.', 'Publicação concluída');
        return;
      }
      const waiting = result.status === 'awaiting_ssl' || result.status === 'awaiting_dns';
      setPendingPublish((prev) =>
        prev
          ? {
              ...prev,
              message: result.message ?? prev.message,
              ...(result.status ? { status: result.status } : {}),
              ...(result.code ? { code: result.code } : {}),
            }
          : prev,
      );
      if (!opts.quiet) onBanner(waiting ? 'warning' : 'critical', result.message ?? 'Ainda não publicada.');
    },
    [pendingPublish?.hostname, onBanner, onLandingUpdate, updateStep],
  );

  // "Verificar novamente" (Story 0.6): reconsulta Vercel + HTTPS e, se tudo
  // responder, conclui a publicação (idempotente — não duplica nada).
  const handleVerify = useCallback(async () => {
    if (!pendingPublish) return;
    setIsVerifying(true);
    try {
      applyVerifyResult(await verifyPublication(pendingPublish.deploymentId));
    } finally {
      setIsVerifying(false);
    }
  }, [pendingPublish, applyVerifyResult]);

  // QA 0.6 F3: aguardando SSL → verifica sozinho com backoff (~3 min).
  const autoVerifyActive =
    Boolean(pendingPublish) &&
    pendingPublish?.status === 'awaiting_ssl' &&
    pendingPublish.code !== 'VERCEL_TOKEN_MISSING' &&
    pendingPublish.code !== 'DOMAIN_PENDING_DNS' &&
    !autoVerifyGaveUp;
  useAutoVerify({
    deploymentId: pendingPublish?.deploymentId ?? null,
    active: autoVerifyActive,
    onResult: (payload) => applyVerifyResult(payload, { quiet: payload.status === 'awaiting_ssl' }),
    onGiveUp: () => setAutoVerifyGaveUp(true),
  });

  // Unpublish — server action reversível: marca deployment como 'unpublished',
  // limpa currentDeploymentId, volta status pra 'draft'. NÃO deleta binding
  // (storefront pode continuar servindo o cache); republish restaura tudo.
  const handleUnpublish = useCallback(async () => {
    setIsUnpublishing(true);
    try {
      const result = await unpublishLandingPage(landing.id);
      if (!result.ok) {
        onBanner('critical', result.message ?? 'Falha ao despublicar.');
        return;
      }
      onLandingUpdate({ status: 'draft' });
      setPublishedHostname(null);
      setConfirmUnpublish(false);
      onBanner('success', 'Landing despublicada. Você pode republicar quando quiser.');
    } catch (err) {
      onBanner('critical', err instanceof Error ? err.message : String(err));
    } finally {
      setIsUnpublishing(false);
    }
  }, [landing.id, onBanner, onLandingUpdate]);

  const domainOptions = domains.map((d) => ({ label: d.domain, value: d.id }));


  return (
    <div id="publish-section">
      <s-section>
        <s-stack gap="large">
          <EditorCardHeader title="Publicação" badges={isPublished ? <s-badge tone="success">Publicada</s-badge> : null} />

          {isPublished && (
            <s-stack gap="small-200">
              {publishedHostname ? (
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-text color="subdued">Ao vivo em:</s-text>
                  <s-link href={`https://${publishedHostname}`} target="_blank">
                    https://{publishedHostname}
                  </s-link>
                </s-stack>
              ) : (
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-text color="subdued">Slug:</s-text>
                  <s-text>
                    {landing.slug || '(sem slug)'} <s-text color="subdued">(domínio pendente)</s-text>
                  </s-text>
                </s-stack>
              )}
              {landing.publishedAt && (
                <s-paragraph color="subdued">Última publicação: {new Date(landing.publishedAt).toLocaleString('pt-BR')}</s-paragraph>
              )}
              {!confirmUnpublish && (
                <s-stack direction="inline">
                  <DsButton variant="tertiary" tone="critical" onClick={() => setConfirmUnpublish(true)} disabled={isPending || isUnpublishing}>
                    Despublicar landing
                  </DsButton>
                </s-stack>
              )}
              {confirmUnpublish && (
                <EditorBanner tone="warning" title="Despublicar esta landing?">
                  <s-stack gap="small-200">
                    <s-paragraph>
                      Landing volta pra rascunho e sai do ar. O HTML, imagens e
                      configurações são preservados — você pode republicar quando
                      quiser.
                    </s-paragraph>
                    <s-stack direction="inline" gap="small-200">
                      <DsButton variant="secondary" tone="critical" onClick={handleUnpublish} loading={isUnpublishing} disabled={isUnpublishing}>
                        Confirmar despublicação
                      </DsButton>
                      <DsButton variant="tertiary" onClick={() => setConfirmUnpublish(false)} disabled={isUnpublishing}>
                        Cancelar
                      </DsButton>
                    </s-stack>
                  </s-stack>
                </EditorBanner>
              )}
            </s-stack>
          )}

          {showDegradedBanner && fidelityInfo && (
            <EditorBanner tone="warning" title="Fidelidade do clone: revisar antes de publicar">
              <s-stack gap="small-200">
                <s-paragraph>
                  Este clone tem issues menores detectadas pelo fidelity gate.
                  A publicação vai prosseguir, mas revise os findings — muitos
                  podem sumir com um reclone.
                </s-paragraph>
                {fidelityInfo.findings.length > 0 && (
                  <s-unordered-list>
                    {fidelityInfo.findings.slice(0, 5).map((f, i) => {
                      const key = parseFindingKey(f);
                      const label = FINDING_LABELS[key];
                      return <s-list-item key={i}>{label ? label : <span className="ds-mono">{f}</span>}</s-list-item>;
                    })}
                    {fidelityInfo.findings.length > 5 && (
                      <s-list-item>
                        <s-text color="subdued">+{fidelityInfo.findings.length - 5} mais…</s-text>
                      </s-list-item>
                    )}
                  </s-unordered-list>
                )}
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <DsButton variant="secondary" onClick={handleReclone} loading={isReclone} disabled={isReclone || !landing.sourceUrl}>
                    Re-clonar
                  </DsButton>
                  {!landing.sourceUrl && <s-text color="subdued">(sem URL de origem gravada — reclone manual)</s-text>}
                </s-stack>
              </s-stack>
            </EditorBanner>
          )}

          {loadingDomains && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-spinner size="base" accessibilityLabel="Carregando domínios" />
              <s-text>Carregando domínios…</s-text>
            </s-stack>
          )}

          {!loadingDomains && domains.length === 0 && (
            <EditorBanner tone="warning" title="Nenhum domínio configurado">
              <s-stack gap="small-200">
                <s-paragraph>Configure um domínio antes de publicar. Domínios são gerenciados na área de configurações.</s-paragraph>
                <s-stack direction="inline">
                  <DsButton variant="secondary" href="/landing-pages/domains">
                    Gerenciar domínios
                  </DsButton>
                </s-stack>
              </s-stack>
            </EditorBanner>
          )}

          {!loadingDomains && domains.length > 0 && (
            <s-stack gap="base">
              <s-grid gridTemplateColumns="minmax(220px, 1fr) minmax(200px, 2fr)" gap="base" alignItems="start">
                <DsSelect label="Domínio raiz" options={domainOptions} value={selectedDomainId} onChange={setSelectedDomainId} disabled={isPending} />
                <DsTextField
                  label="Slug (subdomínio)"
                  value={slug}
                  onChange={setSlug}
                  placeholder="minha-oferta"
                  disabled={isPending}
                  details={`URL após publicar: ${previewUrl}`}
                />
              </s-grid>

              <s-stack direction="inline" justifyContent="end">
                {/* Primário real da ação de publicar (o do cabeçalho só rola até aqui). */}
                <DsButton
                  variant="primary"
                  onClick={handlePublishAll}
                  loading={isPending}
                  disabled={isPending || !selectedDomainId || (!slug.trim() && !liveSelected)}
                >
                  {skipShopify
                    ? isPublished
                      ? 'Republicar landing'
                      : 'Publicar landing'
                    : isPublished
                      ? 'Republicar landing + Shopify'
                      : 'Publicar landing + criar produto Shopify'}
                </DsButton>
              </s-stack>

              {isStripe && !isAdvertorial && (
                <s-paragraph color="subdued">
                  Checkout Stripe: a publicação não cria nem altera produto na Shopify.
                  {liveHost ? ` Republica em ${liveHost.hostname} (endereço atual da landing).` : ''}
                </s-paragraph>
              )}

              {isExternal && !isAdvertorial && (
                <s-paragraph color="subdued">
                  Checkout externo: a publicação não cria nem altera produto na Shopify; os botões levam direto ao
                  checkout do produtor configurado em &quot;Mercado e checkout&quot;.
                </s-paragraph>
              )}

              {isAdvertorial && (
                <s-paragraph color="subdued">
                  Advertorial não cria produto Shopify (CTA do advertorial
                  já aponta pra sales_page).
                </s-paragraph>
              )}
            </s-stack>
          )}

          {/* Story 0.6 — reservada, mas ainda não no ar (SSL/DNS/Vercel) */}
          {pendingPublish && (
            <EditorBanner tone="warning" title={`Ainda não publicada: ${pendingPublish.hostname}`}>
              <s-stack gap="small-200">
                {pendingPublish.message && <s-paragraph>{pendingPublish.message}</s-paragraph>}
                {autoVerifyActive && <s-paragraph>Verificando automaticamente por até 3 minutos — pode continuar editando.</s-paragraph>}
                {autoVerifyGaveUp && (
                  <s-paragraph>Verificamos por 3 minutos e o SSL ainda não respondeu. Clique em &quot;Verificar novamente&quot; mais tarde.</s-paragraph>
                )}
                <s-stack direction="inline">
                  <DsButton variant="secondary" onClick={handleVerify} loading={isVerifying} disabled={isVerifying}>
                    Verificar novamente
                  </DsButton>
                </s-stack>
              </s-stack>
            </EditorBanner>
          )}

          {/* Story 0.6 — checklist de checkout (pendências) */}
          {checkItems && checkItems.some((i) => !i.ok) && (
            <s-stack gap="small-200">
              <s-heading>
                {checkItems.some((i) => !i.ok && i.severity === 'blocking') ? 'Antes de publicar, resolva estes itens' : 'Avisos antes de publicar'}
              </s-heading>
              <LandingPublishChecklist items={checkItems} />
              <s-stack direction="inline">
                <DsButton
                  variant="secondary"
                  onClick={() =>
                    void loadPublishCheck(landing.id).then((r) => {
                      if (r?.ok && r.items) setCheckItems(r.items);
                    })
                  }
                >
                  Conferir de novo
                </DsButton>
              </s-stack>
            </s-stack>
          )}

          {/* Progress steps */}
          {steps.length > 0 && (
            <div aria-live="polite">
              <s-stack gap="small-200">
                {steps.map((s) => {
                  const icon =
                    s.status === 'done'
                      ? { type: 'check-circle-filled', tone: 'success' }
                      : s.status === 'failed'
                        ? { type: 'x-circle-filled', tone: 'critical' }
                        : s.status === 'running' || s.status === 'waiting'
                          ? { type: 'clock', tone: 'info' }
                          : { type: 'circle-dashed', tone: 'neutral' };
                  return (
                    <s-stack key={s.id} direction="inline" gap="small-200" alignItems="start">
                      <s-icon type={icon.type as 'clock'} tone={icon.tone as 'info'} />
                      <s-stack gap="small-100">
                        <s-text color={s.status === 'pending' || s.status === 'skipped' ? 'subdued' : undefined}>{s.label}</s-text>
                        {s.message && <s-text color="subdued">{s.message}</s-text>}
                      </s-stack>
                    </s-stack>
                  );
                })}
              </s-stack>
            </div>
          )}

          <s-divider />
          <ExportPackages landingId={landing.id} />
        </s-stack>
      </s-section>
    </div>
  );
}

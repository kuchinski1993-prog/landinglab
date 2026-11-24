'use client';

// @ds-migrated — Story 20.10c (PR A): "Gerar ou clonar" (`/landing-pages/new`) no design system.
//
// Home = entry point único (Fase 1 + Fase 5). 2 modos:
//   - Gerar do zero: URL do produto → pipeline 5 squads (Research → Copy → Visual → Build → Deploy)
//   - Clonar landing: URL de landing existente → Squad 0 (Puppeteer + downloader + rewriter)
//
// Só visual: a validação, `createAutopilotLandingPage`, o `POST /api/clone-landing`, o SSE
// (`/api/clone-landing/stream`), as fases/pesos/mensagens do progresso e a navegação para o editor são
// os de antes, linha a linha. Mudou a apresentação: título do DS (`DsPageHeader`), página inteira como
// antes (`DsWidePage`, decisão 79), os dois modos como cartões-botão do DS (`DsToggleCard`, com
// `aria-pressed`, sem `style` inline), campos `Ds*`, aviso persistente (`ActionFeedback`) e o progresso
// do clone com `s-progress` e as fases em texto numa região `aria-live`.
//
// Formulário manual detalhado saiu do fluxo principal — vive só em
// /landing-pages/[id]/advanced (edição pós-geração).

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition } from 'react';

import {
  createAutopilotLandingPage,
  type AutopilotLanguage,
  type AutopilotSourceType,
} from './autopilot/actions';

import {
  ActionFeedback,
  DsButton,
  DsChoiceList,
  DsPageHeader,
  DsSelect,
  DsTextArea,
  DsTextField,
  DsToggleCard,
  DsWidePage,
  PolarisGate,
} from '@/components/ds';
import { apiClient } from '@/lib/api-client';
import { parseClonePrefill } from '@/lib/clone-prefill';
import {
  applyExternalCheckoutPath,
  externalPendingMessages,
  type ApplyExternalCheckoutResponse,
} from '@/lib/sphere-offers';

const LANGUAGE_OPTIONS: Array<{ label: string; value: AutopilotLanguage }> = [
  { label: 'Inglês (EN) — padrão global', value: 'en' },
  { label: 'Alemão (DE)', value: 'de' },
  { label: 'Italiano (IT)', value: 'it' },
  { label: 'Espanhol (ES)', value: 'es' },
  { label: 'Francês (FR)', value: 'fr' },
];

const SOURCE_CHOICES = [
  { label: 'Link AliExpress', value: 'aliexpress_link' as const },
  { label: 'Outro e-commerce', value: 'other_url' as const },
  { label: 'Foto do produto', value: 'photo_upload' as const },
];

const LANDING_KIND_CHOICES = [
  {
    label: 'Página de vendas (produto/PDP)',
    value: 'sales_page' as const,
    details:
      'Landing com produto, checkout, bundles, preços. Wizard mostra: tradução → imagens produto → bundles → preços → publicar.',
  },
  {
    label: 'Advertorial (artigo/blog)',
    value: 'advertorial' as const,
    details:
      'Página de aquecimento (blog, notícia, história). Wizard mostra APENAS: tradução → ajustar CTAs → publicar.',
  },
];

const INPUT_MODE_CHOICES = [
  {
    label: 'URL (renderiza com Playwright)',
    value: 'url' as const,
    details: 'Sistema abre a URL, roda Chromium, aguarda JS e extrai. Pode falhar com anti-bot/Cloudflare.',
  },
  {
    label: 'HTML colado (view-source do browser)',
    value: 'html-only' as const,
    details: 'Você cola o HTML que já viu no browser. Bypass 100% anti-bot. Mais rápido, mais fiel ao que você vê.',
  },
];

const CLONE_LANGUAGE_OPTIONS = [
  { label: '(manter idioma original)', value: '' },
  { label: 'Português BR (pt-BR)', value: 'pt-BR' },
  { label: 'Inglês (en)', value: 'en' },
  { label: 'Italiano (it)', value: 'it' },
  { label: 'Espanhol (es)', value: 'es' },
  { label: 'Alemão (de)', value: 'de' },
  { label: 'Francês (fr)', value: 'fr' },
  { label: 'Japonês (ja)', value: 'ja' },
  { label: 'Chinês (zh)', value: 'zh' },
];

type Mode = 'generate' | 'clone';

export default function HomePage(): JSX.Element {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('generate');
  const [isPending, startTransition] = useTransition();

  // Estado modo "generate"
  const [sourceType, setSourceType] = useState<AutopilotSourceType>('aliexpress_link');
  const [url, setUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [targetLanguage, setTargetLanguage] = useState<AutopilotLanguage>('en');

  // Estado modo "clone"
  const [cloneUrl, setCloneUrl] = useState('');
  const [isCloning, setIsCloning] = useState(false);
  const [clonePhase, setClonePhase] = useState<string>('');
  const [cloneSubtext, setCloneSubtext] = useState<string>('');
  const [cloneProgress, setCloneProgress] = useState<number>(0); // 0-100
  // Fase T (set/2026): idioma-alvo + traduzir imagens desde o clone. Vazio = clone puro.
  const [cloneTargetLang, setCloneTargetLang] = useState<string>('');
  const [cloneTranslateImages, setCloneTranslateImages] = useState<boolean>(false);
  // FR-30 / html-only mode: cola view-source direto, bypass anti-bot/Playwright.
  const [cloneInputMode, setCloneInputMode] = useState<'url' | 'html-only'>('url');
  const [cloneHtmlSource, setCloneHtmlSource] = useState<string>('');
  // Wave 1 Item 3: tipo semântico da landing — controla quais steps do wizard
  // aparecem. Default 'sales_page' porque é a maioria dos casos de uso.
  const [cloneLandingKind, setCloneLandingKind] = useState<'advertorial' | 'sales_page'>(
    'sales_page',
  );

  // Story 16.2 (AC 12): `?mode=clone&url=https://...` abre no modo Clonar com a URL preenchida.
  // Lido no mount (sem Suspense de useSearchParams); sem params o comportamento é o de sempre.
  // Story 16.3 (AC 15-16): `&offer=&funnel=` (vindos do "Clonar" do catálogo) → ao concluir o clone,
  // a landing vira checkout externo com os checkouts do funil. Sem eles, nada muda.
  const [cloneSource, setCloneSource] = useState<{ offer: string; funnel: string } | null>(null);
  const [externalNotice, setExternalNotice] = useState<{ landingId: string; lines: string[] } | null>(null);
  useEffect(() => {
    const prefill = parseClonePrefill(window.location.search);
    if (!prefill) return;
    setMode('clone');
    if (prefill.url) setCloneUrl(prefill.url);
    if (prefill.offer && prefill.funnel) setCloneSource({ offer: prefill.offer, funnel: prefill.funnel });
  }, []);

  const [banner, setBanner] = useState<{ tone: 'critical' | 'success'; message: string } | null>(
    null,
  );

  const isPhoto = sourceType === 'photo_upload';

  const handleSourceTypeChange = useCallback((selected: string[]) => {
    const value = selected[0];
    if (value === 'aliexpress_link' || value === 'other_url' || value === 'photo_upload') {
      setSourceType(value);
    }
  }, []);

  const submitGenerate = useCallback(() => {
    setBanner(null);
    if (isPhoto && !imageUrl.trim()) {
      setBanner({ tone: 'critical', message: 'Cole a URL da foto do produto.' });
      return;
    }
    if (!isPhoto && !url.trim()) {
      setBanner({ tone: 'critical', message: 'Cole a URL do produto.' });
      return;
    }
    startTransition(async () => {
      const result = await createAutopilotLandingPage({
        sourceType,
        sourceUrl: isPhoto ? null : url.trim(),
        sourceImageUrl: isPhoto ? imageUrl.trim() : null,
        targetLanguage,
        targetLanguages: [targetLanguage],
        hint: null,
      });
      if (!result.ok) {
        setBanner({ tone: 'critical', message: result.message });
        return;
      }
      router.push(`/landing-pages/${result.data.id}/editor`);
    });
  }, [isPhoto, url, imageUrl, sourceType, targetLanguage, router]);

  const submitClone = useCallback(() => {
    setBanner(null);
    setExternalNotice(null);

    // Validação dual — depende do modo escolhido:
    //   url: URL obrigatória e válida
    //   html-only: HTML colado obrigatório (>=100 chars); URL opcional
    const trimmedHtml = cloneHtmlSource.trim();
    if (cloneInputMode === 'html-only') {
      if (trimmedHtml.length < 100) {
        setBanner({
          tone: 'critical',
          message: 'Cole pelo menos 100 caracteres de HTML pra clonar.',
        });
        return;
      }
      // Em html-only, URL é opcional. Se vazia, backend usa placeholder.
      if (cloneUrl.trim() && !/^https?:\/\//i.test(cloneUrl.trim())) {
        setBanner({
          tone: 'critical',
          message: 'URL inválida — deixe vazio pra usar placeholder ou cole URL http/https.',
        });
        return;
      }
    } else if (!cloneUrl.trim() || !/^https?:\/\//i.test(cloneUrl.trim())) {
      setBanner({ tone: 'critical', message: 'Cole uma URL válida (http/https).' });
      return;
    }

    // Novo fluxo (Fase F.4): POST /api/clone-landing enfileira job no worker
    // Railway → GET /api/clone-landing/stream?jobId=X abre SSE que escuta
    // QueueEvents do BullMQ e retransmite progress do worker em real-time.
    //
    // Fases emitidas pelo processor (via job.updateProgress):
    //   clone:start → clone:render:* → clone:css:* → clone:download:* →
    //   clone:rewrite:* → clone:sanitize:done → upload:started → upload:progress →
    //   upload:done → complete
    setIsCloning(true);
    setClonePhase('Enfileirando…');
    setCloneSubtext('');
    setCloneProgress(1);

    // Pesos estimados por fase (soma = 100). Upload pro Supabase agora domina
    // o tempo (~40% do total) porque as imagens vão pro storage remoto.
    const PHASE_WEIGHTS: Record<string, { weight: number; label: string }> = {
      'clone:start': { weight: 3, label: 'Conectando ao worker…' },
      'clone:render:started': { weight: 5, label: 'Abrindo Chromium…' },
      'clone:render:done': { weight: 40, label: 'Página renderizada' },
      'clone:css:started': { weight: 42, label: 'Analisando CSS…' },
      'clone:css:done': { weight: 45, label: 'CSS extraído' },
      'clone:download:started': { weight: 48, label: 'Baixando assets…' },
      'clone:download:done': { weight: 60, label: 'Assets baixados' },
      'clone:rewrite:started': { weight: 62, label: 'Reescrevendo URLs…' },
      'clone:rewrite:done': { weight: 65, label: 'URLs locais aplicadas' },
      'clone:sanitize:done': { weight: 68, label: 'Removendo scripts de tracking…' },
      'upload:started': { weight: 70, label: 'Enviando pro Supabase…' },
      'upload:done': { weight: 96, label: 'Assets no Supabase' },
      complete: { weight: 100, label: 'Clone concluído' },
    };

    // Passo 1: POST enfileira o job.
    void (async () => {
      let jobId: string;
      let landingId: string;
      try {
        const cloneBody: Record<string, unknown> = {
          url: cloneUrl.trim(),
          targetLanguage: cloneTargetLang || undefined,
          translateImages: cloneTranslateImages && Boolean(cloneTargetLang),
          landingKind: cloneLandingKind,
        };
        if (cloneInputMode === 'html-only' && cloneHtmlSource.trim().length >= 100) {
          cloneBody.htmlOverride = cloneHtmlSource;
        }
        const res = await fetch('/api/clone-landing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(cloneBody),
        });
        const payload = (await res.json()) as {
          ok: boolean;
          jobId?: string;
          landingId?: string;
          message?: string;
        };
        if (!res.ok || !payload.ok || !payload.jobId || !payload.landingId) {
          setBanner({
            tone: 'critical',
            message: payload.message ?? `Falha ao enfileirar clone (${res.status}).`,
          });
          setIsCloning(false);
          return;
        }
        jobId = payload.jobId;
        landingId = payload.landingId;
      } catch (err) {
        setBanner({
          tone: 'critical',
          message: `Erro de rede ao enfileirar clone: ${err instanceof Error ? err.message : String(err)}`,
        });
        setIsCloning(false);
        return;
      }

      // Passo 2: SSE stream escuta o progress do worker.
      const es = new EventSource(`/api/clone-landing/stream?jobId=${encodeURIComponent(jobId)}`);

      es.addEventListener('init', () => {
        setClonePhase('Aguardando worker…');
        setCloneProgress(2);
      });

      es.addEventListener('progress', (ev) => {
        const messageEvt = ev as MessageEvent;
        try {
          const evt = JSON.parse(messageEvt.data) as { phase: string; [k: string]: unknown };
          const meta = PHASE_WEIGHTS[evt.phase];
          if (meta) {
            setCloneProgress(meta.weight);
            setClonePhase(meta.label);
          }
          // Subtextos contextuais por fase.
          if (evt.phase === 'clone:render:done') {
            setCloneSubtext(
              `${evt['imageUrls']} imagens · ${evt['stylesheets']} folhas de estilo · ${evt['fonts']} fontes`,
            );
          } else if (evt.phase === 'clone:download:started') {
            setCloneSubtext(`${evt['total']} arquivos pra baixar`);
          } else if (evt.phase === 'clone:download:done') {
            setCloneSubtext(
              `${evt['ok']} ok${evt['failed'] ? ` · ${evt['failed']} falhas` : ''}`,
            );
          } else if (evt.phase === 'upload:progress') {
            const done = Number(evt['done'] ?? 0);
            const total = Number(evt['total'] ?? 1);
            setCloneSubtext(`Upload Supabase ${done}/${total}`);
            // Interpola pesos 70→96 conforme progresso do upload.
            const upWeight = 70 + Math.round(((done / total) * 26));
            setCloneProgress(Math.min(96, upWeight));
          } else if (evt.phase === 'upload:done') {
            setCloneSubtext(`${evt['count']} arquivos no Supabase`);
          }
        } catch {
          /* silêncio */
        }
      });

      es.addEventListener('complete', () => {
        setCloneProgress(100);
        es.close();
        const goToEditor = () => {
          setClonePhase('Clone concluído — redirecionando…');
          setTimeout(() => {
            router.push(`/landing-pages/${landingId}/editor`);
          }, 400);
        };
        if (!cloneSource) {
          goToEditor();
          return;
        }
        // Story 16.3: aplica o checkout externo do funil. Pendências/erros não bloqueiam: a landing
        // já existe e o operador segue para o editor quando quiser.
        setClonePhase('Clone concluído — configurando checkout externo do funil…');
        void (async () => {
          try {
            const res = await apiClient.post<ApplyExternalCheckoutResponse>(applyExternalCheckoutPath(cloneSource.offer), {
              funnelId: cloneSource.funnel,
              landingPageId: landingId,
            });
            if (res.pending.length === 0) {
              goToEditor();
              return;
            }
            setExternalNotice({
              landingId,
              lines: ['Checkout externo aplicado com kits pendentes (configure no editor):', ...externalPendingMessages(res.pending)],
            });
          } catch (err) {
            setExternalNotice({
              landingId,
              lines: [
                `Clone criado, mas o checkout externo do funil não foi aplicado: ${err instanceof Error ? err.message : String(err)}`,
                'Configure o checkout externo no editor (Checkout).',
              ],
            });
          }
          setIsCloning(false);
          setClonePhase('');
        })();
      });

      es.addEventListener('aborted', (ev) => {
        const messageEvt = ev as MessageEvent;
        let msg = 'Stream perdeu conexão. Recarregue a página pra ver o resultado.';
        try {
          if (messageEvt.data) {
            const evt = JSON.parse(messageEvt.data) as { message?: string };
            msg = evt.message ?? msg;
          }
        } catch {
          /* silêncio */
        }
        setBanner({ tone: 'critical', message: msg });
        setIsCloning(false);
        setClonePhase('');
        setCloneProgress(0);
        es.close();
      });

      es.addEventListener('error', (ev) => {
        const messageEvt = ev as MessageEvent;
        // ev.data=null: conexão fechada abruptamente (Vercel timeout, rede perdida).
        // O job provavelmente ainda está rodando no worker Railway.
        let msg = messageEvt.data
          ? 'Erro na conexão com o servidor.'
          : 'Clone ainda em andamento — recarregue a página pra ver o resultado.';
        try {
          if (messageEvt.data) {
            const evt = JSON.parse(messageEvt.data) as { message?: string };
            msg = evt.message ?? msg;
          }
        } catch {
          /* silêncio */
        }
        setBanner({ tone: 'critical', message: msg });
        setIsCloning(false);
        setClonePhase('');
        setCloneProgress(0);
        es.close();
      });
    })();
  }, [
    cloneUrl,
    cloneTargetLang,
    cloneTranslateImages,
    router,
    cloneInputMode,
    cloneHtmlSource,
    cloneLandingKind,
    cloneSource,
  ]);


  const htmlDetails = `Abra a landing no browser → clique direito → 'Ver código-fonte' (Ctrl+U) → Ctrl+A → Ctrl+C → cole aqui. Mínimo 100 caracteres.${cloneHtmlSource.length > 0 ? ` — ${cloneHtmlSource.length.toLocaleString('pt-BR')} caracteres colados` : ''}`;

  return (
    <PolarisGate>
      {/* Decisão 79: a tela continua ocupando a página inteira, como o `Page fullWidth` de antes. */}
      <DsWidePage>
        <DsPageHeader title="LandingLab" />
        <s-stack gap="base">
          <ActionFeedback
            feedback={banner ? { tone: 'critical', error: banner.message } : null}
            onDismiss={() => setBanner(null)}
          />

          {externalNotice && (
            <s-banner tone="warning" heading="Checkout externo do funil" data-testid="external-checkout-notice">
              <s-stack gap="small-200">
                {externalNotice.lines.map((line) => (
                  <s-paragraph key={line}>{line}</s-paragraph>
                ))}
                <s-stack direction="inline">
                  <DsButton variant="primary" href={`/landing-pages/${externalNotice.landingId}/editor`}>
                    Abrir editor
                  </DsButton>
                </s-stack>
              </s-stack>
            </s-banner>
          )}

          {/* Os dois modos lado a lado, como antes (cartões grandes, mesmo texto). */}
          <div role="group" aria-label="Como criar a landing">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <DsToggleCard
                title="Gerar do zero"
                description="URL do produto → IA cria landing completa"
                pressed={mode === 'generate'}
                onClick={() => setMode('generate')}
              />
              <DsToggleCard
                title="Clonar existente"
                description="URL de landing → cópia local editável"
                pressed={mode === 'clone'}
                onClick={() => setMode('clone')}
              />
            </s-grid>
          </div>

          {mode === 'generate' && (
            <s-section>
              <s-stack gap="large">
                <s-stack gap="small-200">
                  <s-heading>Gerar landing de vendas</s-heading>
                  <s-paragraph color="subdued">
                    Cole a URL do produto. A IA extrai dados, pesquisa mercado, escreve
                    a copy, monta o visual e entrega uma landing pronta em ~2-4 min.
                  </s-paragraph>
                </s-stack>

                <DsChoiceList
                  label="Fonte"
                  labelHidden
                  value={sourceType}
                  options={SOURCE_CHOICES}
                  onChange={(v) => handleSourceTypeChange([v])}
                />

                {isPhoto ? (
                  <DsTextField
                    label="URL da foto do produto"
                    labelHidden
                    value={imageUrl}
                    onChange={setImageUrl}
                    placeholder="https://.../produto.jpg"
                    disabled={isPending}
                  />
                ) : (
                  <DsTextField
                    label="URL do produto"
                    labelHidden
                    value={url}
                    onChange={setUrl}
                    placeholder={
                      sourceType === 'aliexpress_link'
                        ? 'https://aliexpress.com/item/...'
                        : 'https://loja-qualquer.com/produto/...'
                    }
                    disabled={isPending}
                  />
                )}

                <s-grid gridTemplateColumns="minmax(16rem, 22rem) auto" justifyContent="space-between" alignItems="end" gap="base">
                  <DsSelect
                    label="Idioma-alvo (mercado principal)"
                    options={LANGUAGE_OPTIONS}
                    value={targetLanguage}
                    onChange={(v) => setTargetLanguage(v as AutopilotLanguage)}
                    disabled={isPending}
                  />
                  <DsButton variant="primary" onClick={submitGenerate} loading={isPending} disabled={isPending}>
                    Gerar landing
                  </DsButton>
                </s-grid>

                <s-paragraph color="subdued">
                  Precisa mais controle? Depois de gerar, você refina cada bloco na
                  tela de edição — hero, copy, oferta, garantia, tudo editável.
                </s-paragraph>
              </s-stack>
            </s-section>
          )}

          {mode === 'clone' && (
            <s-section>
              <s-stack gap="large">
                <s-stack gap="small-200">
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-heading>Clonar landing existente</s-heading>
                    <s-badge tone="info">Fase 5.A</s-badge>
                  </s-stack>
                  <s-paragraph color="subdued">
                    Duas formas de clonar: (1) cole a URL — sistema renderiza com
                    Chromium e extrai tudo automaticamente, ou (2) cole o HTML da
                    página (view-source do seu browser) — bypass 100% anti-bot,
                    mais fiel ao que você vê logado. Em ambos, imagens/CSS/fontes
                    são baixadas pro seu storage e a landing fica editável.
                  </s-paragraph>
                </s-stack>

                {/* Wave 1 Item 3: escolha tipo semântico ANTES de qualquer input.
                    Wizard adapta os steps automaticamente baseado nesse valor
                    (advertorial pula preços/bundles/imagens; sales_page mostra tudo). */}
                <s-box background="subdued" padding="base" borderRadius="base">
                  <s-stack gap="small-200">
                    <s-heading>1. O que você vai clonar?</s-heading>
                    <DsChoiceList
                      label="Tipo de landing"
                      labelHidden
                      value={cloneLandingKind}
                      options={LANDING_KIND_CHOICES}
                      onChange={(val) => {
                        setCloneLandingKind(val);
                        setBanner(null);
                      }}
                      disabled={isCloning}
                    />
                  </s-stack>
                </s-box>

                <s-heading>2. Fonte da landing</s-heading>

                <DsChoiceList
                  label="Modo de entrada"
                  value={cloneInputMode}
                  options={INPUT_MODE_CHOICES}
                  onChange={(val) => {
                    setCloneInputMode(val);
                    setBanner(null);
                  }}
                  disabled={isCloning}
                />

                <DsTextField
                  label={
                    cloneInputMode === 'html-only'
                      ? 'URL da landing (opcional — só pra registro)'
                      : 'URL da landing'
                  }
                  labelHidden={cloneInputMode === 'url'}
                  value={cloneUrl}
                  onChange={setCloneUrl}
                  placeholder={
                    cloneInputMode === 'html-only'
                      ? 'https://origem.com (opcional — pode deixar vazio)'
                      : 'https://qualquer-loja.com/products/...'
                  }
                  disabled={isCloning}
                  details={
                    cloneInputMode === 'html-only'
                      ? 'Se preencher, URL será usada como base pra absolutizar URLs relativas de imagens/CSS/fontes no HTML. Se vazio, usa placeholder.'
                      : undefined
                  }
                />

                {cloneInputMode === 'html-only' && (
                  // Altura fixa (4 linhas): HTML grande (500KB+) rola DENTRO do campo em vez de empurrar
                  // o botão "Clonar landing" pra baixo da tela.
                  <DsTextArea
                    label="HTML da landing (cole view-source)"
                    value={cloneHtmlSource}
                    onChange={setCloneHtmlSource}
                    rows={4}
                    placeholder="<!DOCTYPE html>..."
                    details={htmlDetails}
                    disabled={isCloning}
                    required
                  />
                )}

                {/* Fase T (set/2026): idioma-alvo + traduzir imagens.
                    Se selecionar idioma, o worker enfileira translate-text
                    automaticamente após o clone. Se marcar imagens, encadeia
                    translate-images depois. Tudo em 1 fluxo sem cliques
                    extras na tela de edição. */}
                <s-box background="subdued" padding="base" borderRadius="base">
                  <s-stack gap="small-200">
                    <s-heading>Idioma da landing clonada</s-heading>
                    <s-paragraph color="subdued">
                      Escolha o idioma final da sua landing. Se a origem
                      está em outro idioma (ex: inglês, japonês), o sistema
                      traduz o texto automaticamente durante o clone.
                    </s-paragraph>
                    <s-box maxInlineSize="360px">
                      <DsSelect
                        label="Idioma-alvo"
                        options={CLONE_LANGUAGE_OPTIONS}
                        value={cloneTargetLang}
                        onChange={(v) => {
                          setCloneTargetLang(v);
                          if (!v) setCloneTranslateImages(false);
                        }}
                        disabled={isCloning}
                      />
                    </s-box>
                    <s-paragraph color="subdued">
                      A IA vai classificar as imagens da landing
                      automaticamente, filtrando as relevantes (produtos,
                      banners com texto) pra você escolher quais trocar no
                      próximo passo do Wizard. Você não precisa marcar nada
                      aqui.
                    </s-paragraph>
                  </s-stack>
                </s-box>

                {/* Progresso do clone (Task #16 SSE): mesma fase, percentual e subtexto de antes; a
                    região viva anuncia cada fase ao leitor de tela. */}
                {isCloning ? (
                  <div aria-live="polite" data-testid="clone-progress">
                    <s-stack gap="small-200">
                      <s-progress value={cloneProgress} max={100} accessibilityLabel="Progresso do clone" />
                      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                        <s-text type="strong" fontWeight="bold">
                          {clonePhase || 'Processando…'}
                        </s-text>
                        <s-text color="subdued">{`${cloneProgress}%`}</s-text>
                      </s-stack>
                      {cloneSubtext && <s-text color="subdued">{cloneSubtext}</s-text>}
                    </s-stack>
                  </div>
                ) : (
                  <s-stack direction="inline" justifyContent="end">
                    <DsButton
                      variant="primary"
                      onClick={submitClone}
                      disabled={
                        isPending ||
                        (cloneInputMode === 'url'
                          ? !cloneUrl.trim()
                          : cloneHtmlSource.trim().length < 100)
                      }
                    >
                      Clonar landing
                    </DsButton>
                  </s-stack>
                )}

                <s-unordered-list>
                  <s-list-item>Tempo: ~30-90s dependendo do peso do site</s-list-item>
                  <s-list-item>
                    Sanitização: scripts de tracking (GA, Meta Pixel, hotjar) são
                    removidos automaticamente
                  </s-list-item>
                  <s-list-item>
                    Tradução opcional: texto (Haiku, ~$0.03) + imagens
                    (OCR+Seedream, ~$0.15/img) rodam automaticamente após o
                    clone se você escolher um idioma acima.
                  </s-list-item>
                </s-unordered-list>
              </s-stack>
            </s-section>
          )}

          <s-section>
            <s-stack gap="small-200">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-heading>Landings anteriores</s-heading>
                <DsButton variant="tertiary" href="/landing-pages">
                  Ver todas
                </DsButton>
              </s-stack>
              <s-paragraph color="subdued">
                Acesse a lista completa pra editar, publicar ou excluir landings já
                geradas.
              </s-paragraph>
            </s-stack>
          </s-section>
        </s-stack>
      </DsWidePage>
    </PolarisGate>
  );
}

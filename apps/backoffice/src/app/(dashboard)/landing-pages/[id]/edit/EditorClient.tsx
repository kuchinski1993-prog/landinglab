'use client';

// @ds-migrated — Story 20.13b (PR D): editor visual inline no design system. SÓ VISUAL: estado, mensagens
// do iframe (postMessage), descartar e salvar (upload + PATCH em lote) são os de antes, linha a linha.
// Mudou o JSX: barra com o `DsPageHeader` (título 26px/700, ações `DsButton` na linha, selos
// `DsToneBadge`), erro em `DsNoticeBanner`, carregando em `s-spinner`, tudo dentro do `PolarisGate`.
// [AUTO-DECISION] O editor ocupa a ÁREA DE CONTEÚDO do painel (altura = tela − cabeçalho), em vez de
// `position: fixed; inset: 0; z-index: 500`: desde a moldura da Story 20.14a (z-index 505) e o cabeçalho
// (512), a barra ficava por baixo do cabeçalho e o começo dela por baixo do menu — "Salvar", "Descartar" e
// "Voltar" sem clique (prints `antes-*` da 20.13b). No fluxo, o menu/cabeçalho/moldura e o celular seguem
// as regras do shell.
//
// EditorClient — UI do editor visual inline.
//
// Layout:
//   ┌─ toolbar top (Salvar N edits | Descartar | Voltar) ──────────────┐
//   │                                                                    │
//   │            iframe full-screen (landing com ?edit=1)                │
//   │                                                                    │
//   └────────────────────────────────────────────────────────────────────┘
//
// Comunicação parent ↔ iframe via postMessage:
//   - Iframe → parent: { type: 'll-text-edit', id, newText }
//                      { type: 'll-image-click', id, currentSrc }
//                      { type: 'll-editor-ready' }
//
// State local (in-memory only, persiste só no Salvar):
//   - textEdits: Map<id, newText>
//   - imageEdits: Map<id, { originalUrl, newFile }>
//
// Story 26.1 — seções, botões e preços (marcados no servidor, IDs `s_/b_/p_`):
//   - Iframe → parent: { type: 'll-sections', sections } · { type: 'll-target-click', chain }
//   - Parent → iframe: { type: 'll-apply-preview', sectionEdits, buttonEdits, priceEdits } · { type: 'll-select', id }
//   - sectionEdits: Map<id, 'hide'|'show'|'remove'> · buttonEdits: Map<id, { text?, href? }> · priceEdits: Map<id, text>
//   - "Versões": as 10 últimas versões salvas pelo editor (restaurar = POST .../edit-inline/restore).

import { useCallback, useEffect, useRef, useState } from 'react';


import TargetPanel, {
  hrefProblem,
  type ButtonDraft,
  type SectionAction,
  type SectionInfo,
  type TargetInfo,
} from './TargetPanel';
import VersionsModal from './VersionsModal';

import {
  DsButton,
  DsNoticeBanner,
  DsPageHeader,
  DsToneBadge,
  GateSkeleton,
  PolarisGate,
} from '@/components/ds';

interface Props {
  landingId: string;
  landingTitle: string;
}

interface TextEdit {
  id: string;
  newText: string;
}

interface ImageEdit {
  id: string;
  originalUrl: string;
  file: File;
  objectUrl: string;
}

type SaveState = 'idle' | 'saving' | 'success' | 'error';

export default function EditorClient({ landingId, landingTitle }: Props): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [textEdits, setTextEdits] = useState<Map<string, string>>(new Map());
  const [imageEdits, setImageEdits] = useState<Map<string, ImageEdit>>(new Map());
  const [pendingImageId, setPendingImageId] = useState<{ id: string; url: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);

  // Story 26.1
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [chain, setChain] = useState<TargetInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sectionEdits, setSectionEdits] = useState<Map<string, SectionAction>>(new Map());
  const [buttonEdits, setButtonEdits] = useState<Map<string, ButtonDraft>>(new Map());
  const [priceEdits, setPriceEdits] = useState<Map<string, string>>(new Map());
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);

  // Cache-buster pra forçar iframe reload após save (invalida CDN)
  const [reloadNonce, setReloadNonce] = useState(0);

  const previewUrl = `/landing-pages/${landingId}/preview?edit=inline&_n=${reloadNonce}`;

  const totalEdits =
    textEdits.size + imageEdits.size + sectionEdits.size + buttonEdits.size + priceEdits.size;
  const invalidHref = Array.from(buttonEdits.values()).some(
    (b) => b.href !== undefined && !!hrefProblem(b.href)
  );

  // Handler global de postMessage do iframe
  useEffect(() => {
    function onMessage(ev: MessageEvent): void {
      const data = ev.data as {
        type?: string;
        id?: string;
        newText?: string;
        currentSrc?: string;
        sections?: SectionInfo[];
        chain?: TargetInfo[];
      };
      if (!data || typeof data.type !== 'string') return;
      if (ev.source && iframeRef.current && ev.source !== iframeRef.current.contentWindow) return;

      if (data.type === 'll-sections' && Array.isArray(data.sections)) {
        setSections(data.sections);
        return;
      }

      if (data.type === 'll-target-click' && Array.isArray(data.chain) && data.chain.length > 0) {
        setChain(data.chain);
        setSelectedId(data.chain[0]!.id);
        return;
      }

      if (data.type === 'll-editor-ready') {
        setIframeReady(true);
        return;
      }

      if (data.type === 'll-text-edit' && data.id && typeof data.newText === 'string') {
        setTextEdits((prev) => {
          const next = new Map(prev);
          next.set(data.id as string, data.newText as string);
          return next;
        });
        return;
      }

      if (data.type === 'll-image-click' && data.id && data.currentSrc) {
        setPendingImageId({ id: data.id, url: data.currentSrc });
        setTimeout(() => fileInputRef.current?.click(), 0);
        return;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const handleImagePicked = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      ev.target.value = ''; // permite selecionar o mesmo arquivo de novo
      if (!file || !pendingImageId) return;

      const objectUrl = URL.createObjectURL(file);
      const { id, url } = pendingImageId;
      setImageEdits((prev) => {
        const next = new Map(prev);
        const existing = next.get(id);
        if (existing) URL.revokeObjectURL(existing.objectUrl);
        next.set(id, { id, originalUrl: url, file, objectUrl });
        return next;
      });

      // Preview instantâneo dentro do iframe
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'll-image-preview', id, newSrc: objectUrl },
        '*'
      );
      setPendingImageId(null);
    },
    [pendingImageId]
  );

  // Prévia das edições de seção/botão/preço dentro do iframe (estado completo; o iframe refaz do zero).
  useEffect(() => {
    if (!iframeReady) return;
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: 'll-apply-preview',
        sectionEdits: Array.from(sectionEdits, ([id, action]) => ({ id, action })),
        buttonEdits: Array.from(buttonEdits, ([id, b]) => ({ id, ...b })),
        priceEdits: Array.from(priceEdits, ([id, text]) => ({ id, text })),
      },
      '*'
    );
  }, [iframeReady, sectionEdits, buttonEdits, priceEdits]);

  const resetTargets = useCallback(() => {
    setSectionEdits(new Map());
    setButtonEdits(new Map());
    setPriceEdits(new Map());
    setChain([]);
    setSelectedId(null);
    setSections([]);
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      const sec = sections.find((s) => s.id === id);
      if (sec && !chain.some((t) => t.id === id)) {
        setChain([
          {
            id,
            kind: 'section',
            label: sec.label,
            text: '',
            href: '',
            multi: false,
            hidden: sec.hidden,
          },
        ]);
      }
      iframeRef.current?.contentWindow?.postMessage({ type: 'll-select', id }, '*');
    },
    [sections, chain]
  );

  const handleSectionAction = useCallback((section: SectionInfo, action: SectionAction | null) => {
    setSectionEdits((prev) => {
      const next = new Map(prev);
      // 'show' numa seção já visível (ou 'hide' numa já oculta) = sem mudança.
      const noop =
        action === null ||
        (action === 'show' && !section.hidden) ||
        (action === 'hide' && section.hidden);
      if (noop) next.delete(section.id);
      else next.set(section.id, action);
      return next;
    });
  }, []);

  const handleButtonChange = useCallback(
    (target: TargetInfo, field: 'text' | 'href', value: string) => {
      setButtonEdits((prev) => {
        const next = new Map(prev);
        const draft: ButtonDraft = { ...(next.get(target.id) ?? {}) };
        const original = field === 'text' ? target.text : target.href;
        if (value === original) delete draft[field];
        else draft[field] = value;
        if (draft.text === undefined && draft.href === undefined) next.delete(target.id);
        else next.set(target.id, draft);
        return next;
      });
    },
    []
  );

  const handlePriceChange = useCallback((target: TargetInfo, value: string) => {
    setPriceEdits((prev) => {
      const next = new Map(prev);
      if (value === target.text) next.delete(target.id);
      else next.set(target.id, value);
      return next;
    });
  }, []);

  const handleRestored = useCallback(() => {
    imageEdits.forEach((e) => URL.revokeObjectURL(e.objectUrl));
    setTextEdits(new Map());
    setImageEdits(new Map());
    resetTargets();
    setVersionsOpen(false);
    setReloadNonce((n) => n + 1);
    setIframeReady(false);
    setSaveState('success');
    setTimeout(() => setSaveState('idle'), 2500);
  }, [imageEdits, resetTargets]);

  const handleDiscard = useCallback(() => {
    if (totalEdits === 0) return;
    if (!confirm(`Descartar ${totalEdits} edição(ões) não salvas?`)) return;
    // Revoga blob URLs
    imageEdits.forEach((e) => URL.revokeObjectURL(e.objectUrl));
    setTextEdits(new Map());
    setImageEdits(new Map());
    resetTargets();
    setReloadNonce((n) => n + 1);
    setIframeReady(false);
    setSaveState('idle');
    setErrorMsg(null);
  }, [imageEdits, textEdits, totalEdits, resetTargets]);

  const handleSave = useCallback(async () => {
    if (totalEdits === 0) return;
    if (invalidHref) {
      setErrorMsg('Corrija o link do botão antes de salvar (https:// ou #id-da-seção).');
      setSaveState('error');
      return;
    }
    setSaveState('saving');
    setErrorMsg(null);
    setSaveWarning(null);

    try {
      // 1. Upload de imagens editadas (uma por uma, reusa /api/upload-edited-image)
      const imagePayload: Array<{ id: string; newUrl: string }> = [];
      for (const edit of imageEdits.values()) {
        const fd = new FormData();
        fd.set('file', edit.file);
        fd.set('originalUrl', edit.originalUrl);
        const res = await fetch('/api/upload-edited-image', { method: 'POST', body: fd });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
        if (!res.ok || !json.ok) {
          throw new Error(`Upload de imagem falhou: ${json.message ?? res.status}`);
        }
        // URL final = originalUrl (upsert no mesmo path) + cache-buster
        const cacheBusted = `${edit.originalUrl.split('?')[0]}?v=${Date.now()}`;
        imagePayload.push({ id: edit.id, newUrl: cacheBusted });
      }

      // 2. PATCH batch de text + image edits no html_body
      const textPayload = Array.from(textEdits.entries()).map(
        ([id, newText]): TextEdit => ({ id, newText })
      );

      const res = await fetch(`/api/landing-pages/${landingId}/edit-inline`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          textEdits: textPayload,
          imageEdits: imagePayload,
          // Story 26.1 — só vão no corpo quando há edição desse tipo.
          ...(sectionEdits.size > 0 && {
            sectionEdits: Array.from(sectionEdits, ([id, action]) => ({ id, action })),
          }),
          ...(buttonEdits.size > 0 && {
            buttonEdits: Array.from(buttonEdits, ([id, b]) => ({
              id,
              ...b,
              ...(b.href !== undefined && { href: b.href.trim() }),
            })),
          }),
          ...(priceEdits.size > 0 && {
            priceEdits: Array.from(priceEdits, ([id, text]) => ({ id, text })),
          }),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        applied?: number;
        skipped?: number;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.message ?? `HTTP ${res.status}`);
      }
      if (json.skipped) {
        setSaveWarning(
          `${json.skipped} edição(ões) não aplicada(s): o elemento não foi encontrado (a página mudou?).`
        );
      }

      // 3. Sucesso — limpa state e recarrega iframe
      imageEdits.forEach((e) => URL.revokeObjectURL(e.objectUrl));
      setTextEdits(new Map());
      setImageEdits(new Map());
      resetTargets();
      setReloadNonce((n) => n + 1);
      setIframeReady(false);
      setSaveState('success');
      setTimeout(() => setSaveState('idle'), 2500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao salvar');
      setSaveState('error');
    }
  }, [
    imageEdits,
    textEdits,
    totalEdits,
    landingId,
    invalidHref,
    sectionEdits,
    buttonEdits,
    priceEdits,
    resetTargets,
  ]);

  return (
    <PolarisGate
      fallback={
        <div style={{ height: 'calc(100vh - var(--ds-shell-topbar-h, 0px))', padding: 16 }}>
          <GateSkeleton cards={1} />
        </div>
      }
    >
      <div
        style={{
          height: 'calc(100vh - var(--ds-shell-topbar-h, 0px))',
          background: 'var(--p-color-bg, #f1f1f1)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Barra: título e ações pelo cabeçalho do DS (26px/700, ações na linha do título) */}
        <div
          style={{
            padding: '0 16px',
            background: 'var(--p-color-bg-surface, #fff)',
            borderBottom: '1px solid var(--p-color-border, #e3e3e3)',
          }}
        >
          <DsPageHeader
            title={`Editor visual — ${landingTitle}`}
            accessory={
              <>
                {totalEdits > 0 && (
                  <DsToneBadge tone="attention">{`${totalEdits} edição(ões) pendentes`}</DsToneBadge>
                )}
                {saveState === 'success' && <DsToneBadge tone="success">Salvo</DsToneBadge>}
              </>
            }
            secondaryActions={
              <>
                <DsButton
                  href={`/landing-pages/${landingId}/editor`}
                  variant="tertiary"
                  disabled={saveState === 'saving'}
                >
                  ← Voltar
                </DsButton>
                <DsButton
                  variant="secondary"
                  onClick={handleDiscard}
                  disabled={totalEdits === 0 || saveState === 'saving'}
                >
                  Descartar
                </DsButton>
                <DsButton
                  variant="secondary"
                  onClick={() => setVersionsOpen(true)}
                  disabled={saveState === 'saving'}
                >
                  Versões
                </DsButton>
              </>
            }
            primaryAction={
              <DsButton
                variant="primary"
                onClick={() => void handleSave()}
                disabled={totalEdits === 0}
                loading={saveState === 'saving'}
              >
                Salvar {totalEdits > 0 ? `(${totalEdits})` : ''}
              </DsButton>
            }
          />
        </div>

        {/* Aviso de erro */}
        {saveState === 'error' && errorMsg && (
          <div style={{ padding: '8px 16px', background: 'var(--p-color-bg-surface, #fff)' }}>
            <DsNoticeBanner tone="critical" onDismiss={() => setSaveState('idle')}>
              {errorMsg}
            </DsNoticeBanner>
          </div>
        )}

        {saveWarning && (
          <div style={{ padding: '8px 16px', background: 'var(--p-color-bg-surface, #fff)' }}>
            <DsNoticeBanner tone="warning" onDismiss={() => setSaveWarning(null)}>
              {saveWarning}
            </DsNoticeBanner>
          </div>
        )}

        {/* Instrução */}
        <div
          style={{
            padding: '8px 16px',
            background: 'var(--p-color-bg-surface-caution, #fff8db)',
            borderBottom: '1px solid var(--p-color-border-caution, #ffe58f)',
          }}
        >
          <s-text>
            <strong>Como usar:</strong> Passe o mouse sobre texto pra editar inline. Clique em
            qualquer imagem pra trocá-la. Clique numa seção, botão ou preço pra editar no painel ao
            lado (ocultar/excluir seção, texto e link do botão, preço mostrado). Nada é salvo até
            você clicar em &quot;Salvar&quot;.
          </s-text>
        </div>

        {/* Iframe + painel (Story 26.1) */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, position: 'relative', background: '#fff' }}>
            {!iframeReady && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  zIndex: 1,
                }}
              >
                <s-spinner size="base" accessibilityLabel="Carregando landing" />
                <s-text color="subdued">Carregando landing...</s-text>
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={previewUrl}
              title="Landing editor"
              style={{
                width: '100%',
                height: '100%',
                border: 0,
                background: '#fff',
                display: 'block',
              }}
            />
          </div>
          <TargetPanel
            chain={chain}
            selectedId={selectedId}
            sections={sections}
            sectionEdits={sectionEdits}
            buttonEdits={buttonEdits}
            priceEdits={priceEdits}
            disabled={saveState === 'saving'}
            onSelect={handleSelect}
            onSectionAction={handleSectionAction}
            onButtonChange={handleButtonChange}
            onPriceChange={handlePriceChange}
          />
        </div>

        <VersionsModal
          open={versionsOpen}
          landingId={landingId}
          pendingEdits={totalEdits}
          onClose={() => setVersionsOpen(false)}
          onRestored={handleRestored}
        />

        {/* File input hidden pra upload de imagem */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleImagePicked}
        />
      </div>
    </PolarisGate>
  );
}

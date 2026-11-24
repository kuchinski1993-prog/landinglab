'use client';

// @ds-migrated — Story 20.10a (retrabalho, feedback do owner): prévia da página no topo do cartão.
//
// Landing com HTML → a página renderizada numa "tela" de 1280×800 reduzida à largura do cartão
// (16:10), num iframe `sandbox=""` (sem scripts, origem opaca, sem formulário/popup/navegação) que
// lê o preview do sistema em modo miniatura (`/api/landing-preview/<id>?thumb=1`: sem scripts,
// noscript/pixels e frames, CSP fechada). Sem HTML → a imagem hero; sem hero → as iniciais do título.
// Desempenho: o iframe só ganha `src` quando o cartão chega perto da tela (IntersectionObserver) e
// há vaga na fila (no máximo `MAX_CONCURRENT_PREVIEWS` carregando juntas); depois de carregada a
// prévia fica (rolar de volta não baixa de novo). Enquanto carrega (ou se falhar) aparece o
// placeholder — nunca um quadro branco piscando. Com a vaga na mão, a página só é montada quando a
// pessoa para de rolar (`whenScrollIdle`): montar uma página pesada no meio da rolagem trava quadros.
// A prévia é decorativa (`aria-hidden`, fora do Tab, sem clique): o título do cartão é o link.

import { useEffect, useRef, useState } from 'react';

import { PREVIEW_ASPECT_RATIO, PREVIEW_VIEWPORT, previewKind, previewThumbHref, titleInitials } from '../_lib/landing-list';
import { PREVIEW_SLOT_TIMEOUT_MS, previewQueue, whenScrollIdle } from '../_lib/preview-queue';

import type { LandingPageSummary } from '@/lib/landing-types';

/** Começa a carregar um pouco antes de o cartão aparecer (meia tela de folga). */
const PREVIEW_ROOT_MARGIN = '400px 0px';

const FRAME_BOX = { position: 'relative', inlineSize: '100%', aspectRatio: PREVIEW_ASPECT_RATIO, overflow: 'hidden' } as const;
const FILL = { position: 'absolute', inset: 0 } as const;

type Phase = 'idle' | 'loading' | 'loaded';

export interface LandingPreviewProps {
  landing: Pick<LandingPageSummary, 'id' | 'title' | 'hasHtml' | 'heroImageUrl'>;
}

function Placeholder({ title }: { title: string }): JSX.Element {
  return (
    <div style={FILL} data-testid="landing-preview-placeholder">
      <s-stack alignItems="center" justifyContent="center" blockSize="100%" gap="small-200">
        <span style={{ fontSize: '2.25rem', lineHeight: 1, fontWeight: 700, color: 'var(--ds-color-text-secondary)', letterSpacing: '0.02em' }}>
          {titleInitials(title)}
        </span>
      </s-stack>
    </div>
  );
}

export function LandingPreview({ landing }: LandingPreviewProps): JSX.Element {
  const kind = previewKind(landing);
  const boxRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [scale, setScale] = useState(0);
  const [heroFailed, setHeroFailed] = useState(false);
  const releaseRef = useRef<(() => void) | null>(null);
  const cancelIdleRef = useRef<(() => void) | null>(null);

  // Escala = largura do cartão / 1280 (a grade muda de largura com a janela).
  useEffect(() => {
    const box = boxRef.current;
    if (kind !== 'page' || !box) return undefined;
    const update = (): void => setScale(box.clientWidth / PREVIEW_VIEWPORT.width);
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, [kind]);

  // Perto da tela → pede vaga; saiu da tela antes da vez → sai da fila. Já carregando/carregada: fica.
  useEffect(() => {
    const box = boxRef.current;
    if (kind !== 'page' || !box || phase !== 'idle') return undefined;
    const enqueue = (): void => {
      if (releaseRef.current) return;
      // Com a vaga, espera a pessoa parar de rolar para montar a página (não trava a rolagem).
      releaseRef.current = previewQueue.request(() => {
        cancelIdleRef.current = whenScrollIdle(() => setPhase('loading'));
      });
    };
    const leave = (): void => {
      cancelIdleRef.current?.();
      cancelIdleRef.current = null;
      releaseRef.current?.();
      releaseRef.current = null;
    };
    if (typeof IntersectionObserver === 'undefined') {
      enqueue();
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) enqueue();
        else leave();
      },
      { rootMargin: PREVIEW_ROOT_MARGIN },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [kind, phase]);

  // Carregando: devolve a vaga no `load` ou depois de 15 s (o iframe continua, só não segura a fila).
  useEffect(() => {
    if (phase !== 'loading') return undefined;
    const t = setTimeout(() => {
      releaseRef.current?.();
      releaseRef.current = null;
    }, PREVIEW_SLOT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // Cartão desmontado (troca de página/filtro) com vaga ou lugar na fila: devolve.
  useEffect(
    () => () => {
      cancelIdleRef.current?.();
      releaseRef.current?.();
      releaseRef.current = null;
    },
    [],
  );

  function handleLoad(): void {
    releaseRef.current?.();
    releaseRef.current = null;
    setPhase('loaded');
  }

  return (
    <s-box background="subdued" data-testid="landing-preview" data-preview-kind={kind} data-preview-phase={kind === 'page' ? phase : undefined}>
      <div ref={boxRef} style={FRAME_BOX} aria-hidden="true">
        {kind === 'hero' && landing.heroImageUrl && !heroFailed ? (
          // <img> e não s-image: imagem externa (CDN da landing) cujo onError cai no placeholder
          <img
            src={landing.heroImageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setHeroFailed(true)}
            style={{ ...FILL, inlineSize: '100%', blockSize: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : null}
        {kind === 'placeholder' || (kind === 'hero' && heroFailed) || (kind === 'page' && phase !== 'loaded') ? <Placeholder title={landing.title} /> : null}
        {kind === 'page' && phase !== 'idle' && scale > 0 ? (
          <iframe
            src={previewThumbHref(landing.id)}
            title={`Prévia de ${landing.title}`}
            sandbox=""
            loading="lazy"
            referrerPolicy="no-referrer"
            tabIndex={-1}
            aria-hidden="true"
            onLoad={handleLoad}
            data-testid="landing-preview-frame"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: `${PREVIEW_VIEWPORT.width}px`,
              height: `${PREVIEW_VIEWPORT.height}px`,
              border: 0,
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
              pointerEvents: 'none',
              userSelect: 'none',
              background: '#fff',
              opacity: phase === 'loaded' ? 1 : 0,
              transition: 'opacity 200ms ease',
            }}
          />
        ) : null}
      </div>
    </s-box>
  );
}

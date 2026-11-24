'use client';

// @ds-migrated — Story 20.10a (retrabalho, feedback do owner): cartão da grade de landings.
//
// O owner preferiu a grade de cartões de antes, agora com a PRÉVIA da página no topo
// (`LandingPreview`). Mesma informação da linha da 1ª versão: título, /slug, marcas (Legacy,
// estado do clone, IA, fidelidade com dica, status), progresso da IA em texto, preço, data, último
// erro (resumo + texto inteiro na dica e para leitor de tela) e as ações Editar, Abrir site/Ver
// preview e Excluir.
//
// Cartão inteiro clicável SEM aninhar controles (o defeito L3 era um <button> com botões e links
// dentro): o título é o único link (`s-link` neutro em negrito, no Tab, Enter abre); um clique em
// qualquer outro ponto do cartão que não seja botão/link abre o editor pelo router, e
// Ctrl/Cmd/Shift/Alt/botão do meio abrem em nova aba (`window.open(…, 'noopener')`). No título, o
// clique simples vai pelo router (`useRowLink`) e o modificado fica com o `href` nativo. Arrastar
// para selecionar texto não abre a landing. Mão (`cursor: pointer`) e sombra no cartão inteiro.

import { useEffect, useRef, useState } from 'react';

import { editorHref, errorSummary, landingBadges, landingLinkId, priceLabel, progressInfo, siteLink } from '../_lib/landing-list';

import { LandingPreview } from './LandingPreview';

import { DsButton, isModifiedClick, useRowLink } from '@/components/ds';
import type { LandingPageSummary } from '@/lib/landing-types';

/** Resumo do erro em no máximo 2 linhas (o texto inteiro fica na dica e para leitor de tela). */
const ERROR_CLAMP = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
} as const;

/** Título longo em até 2 linhas: os cartões da mesma fileira ficam com a mesma altura de cabeçalho. */
const TITLE_CLAMP = { ...ERROR_CLAMP, overflowWrap: 'anywhere' } as const;

const CARD_SHADOW_HOVER = '0 6px 16px rgba(26, 26, 26, 0.14)';

/** Controles do cartão: o clique neles é deles (não abre a landing pelo cartão). */
const INTERACTIVE = 's-link, s-button, s-clickable, a, button, input, select, textarea';

export interface LandingCardProps {
  landing: LandingPageSummary;
  onOpen: (id: string) => void;
  onDelete: (landing: LandingPageSummary) => void;
}

function selectionInside(el: Element): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.toString().trim() === '') return false;
  return sel.anchorNode ? el.contains(sel.anchorNode) : false;
}

export function LandingCard({ landing, onOpen, onDelete }: LandingCardProps): JSX.Element {
  const linkRef = useRef<HTMLElementTagNameMap['s-link']>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const linkId = landingLinkId(landing.id);
  const href = editorHref(landing.id);
  useRowLink(linkRef, () => onOpen(landing.id));

  // Clique no corpo do cartão (fora de botões/links): simples → router; modificado/meio → nova aba.
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    const onClick = (event: MouseEvent): void => {
      if (event.type === 'auxclick' && event.button !== 1) return;
      if ((event.target as Element | null)?.closest(INTERACTIVE)) return;
      if (selectionInside(card)) return;
      if (isModifiedClick(event)) {
        event.preventDefault();
        window.open(href, '_blank', 'noopener');
        return;
      }
      onOpenRef.current(landing.id);
    };
    card.addEventListener('click', onClick);
    card.addEventListener('auxclick', onClick);
    return () => {
      card.removeEventListener('click', onClick);
      card.removeEventListener('auxclick', onClick);
    };
  }, [href, landing.id]);

  const badges = landingBadges(landing);
  const progress = landing.generationMode === 'autopilot' ? progressInfo(landing.squadProgress) : null;
  const error = landing.lastError ? errorSummary(landing.lastError) : null;
  const site = siteLink(landing);
  const progressTip = `landing-progress-${landing.id}`;
  const errorTip = `landing-error-${landing.id}`;
  const siteTip = `landing-site-${landing.id}`;

  return (
    <div
      ref={cardRef}
      data-testid="landing-card"
      data-landing-id={landing.id}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        // grade de 1 célula: o s-section estica até a altura da fileira (cartões da mesma fileira iguais)
        display: 'grid',
        blockSize: '100%',
        cursor: 'pointer',
        borderRadius: 'var(--ds-radius-300)',
        boxShadow: hover ? CARD_SHADOW_HOVER : 'none',
        transform: hover ? 'translateY(-1px)' : 'none',
        transition: 'box-shadow 120ms ease, transform 120ms ease',
      }}
    >
      <s-section padding="none">
        <LandingPreview landing={landing} />
        <s-box padding="base">
          <s-stack gap="small-300">
            <s-stack gap="small-500">
              <div style={TITLE_CLAMP}>
                <s-link ref={linkRef} id={linkId} href={href} tone="neutral">
                  <s-text type="strong" fontWeight="bold">
                    {landing.title}
                  </s-text>
                </s-link>
              </div>
              <s-text color="subdued">/{landing.slug}</s-text>
            </s-stack>

            <s-stack direction="inline" gap="small-200">
              {badges.map((b) =>
                b.hint ? (
                  // O s-badge não tem dica própria: o s-text em volta liga o s-tooltip (descrição e achados da fidelidade).
                  <s-text key={b.key} interestFor={`landing-${b.key}-${landing.id}`}>
                    <s-badge tone={b.tone} data-badge={b.key}>
                      {b.label}
                    </s-badge>
                    <s-tooltip id={`landing-${b.key}-${landing.id}`}>{b.hint}</s-tooltip>
                    <s-text accessibilityVisibility="exclusive">{` ${b.hint}`}</s-text>
                  </s-text>
                ) : (
                  <s-badge key={b.key} tone={b.tone} icon={b.icon} data-badge={b.key}>
                    {b.label}
                  </s-badge>
                ),
              )}
            </s-stack>

            {progress ? (
              <s-box>
                <s-text tone={progress.failed ? 'critical' : undefined} color={progress.failed ? undefined : 'subdued'} interestFor={progressTip} data-testid="landing-progress">
                  {progress.text}
                </s-text>
                <s-tooltip id={progressTip}>{progress.detail}</s-tooltip>
                <s-text accessibilityVisibility="exclusive">{progress.detail}</s-text>
              </s-box>
            ) : null}

            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small-200">
              <s-text type="strong" fontWeight="bold">
                {priceLabel(landing.currency, landing.price)}
              </s-text>
              <s-text color="subdued">{new Date(landing.createdAt).toLocaleDateString('pt-BR')}</s-text>
            </s-stack>

            {error ? (
              <s-box>
                <div style={ERROR_CLAMP}>
                  <s-text tone="critical" interestFor={error.truncated ? errorTip : undefined} data-testid="landing-error">
                    {`Erro: ${error.summary}`}
                  </s-text>
                </div>
                {error.truncated ? (
                  <>
                    <s-tooltip id={errorTip}>{landing.lastError}</s-tooltip>
                    <s-text accessibilityVisibility="exclusive" data-testid="landing-error-full">
                      {`Erro completo: ${landing.lastError}`}
                    </s-text>
                  </>
                ) : null}
              </s-box>
            ) : null}

            <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <DsButton variant="secondary" href={href} accessibilityLabel={`Editar ${landing.title}`}>
                  Editar
                </DsButton>
                <DsButton
                  variant="secondary"
                  href={site.href}
                  target="_blank"
                  interestFor={siteTip}
                  accessibilityLabel={`${site.label}: ${landing.title} (abre em nova aba)`}
                >
                  {site.label}
                </DsButton>
              </s-stack>
              <DsButton variant="tertiary" tone="critical" onClick={() => onDelete(landing)} accessibilityLabel={`Excluir ${landing.title}`}>
                Excluir
              </DsButton>
            </s-stack>
            <s-tooltip id={siteTip}>{site.hint}</s-tooltip>
          </s-stack>
        </s-box>
      </s-section>
    </div>
  );
}

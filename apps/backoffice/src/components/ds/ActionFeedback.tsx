'use client';

// Story 20.5a — feedback de ações no visual novo (substitui o `Toast` do Polaris React, que não
// existe no Polaris Web Components fora do admin da Shopify).
//
// Um `s-banner` no topo da tela, dentro de uma região viva (anuncia sem roubar o foco — sucesso em
// `role="status"`, erro em `role="alert"`, Story 20.5a PR2 / A11Y-001):
// - sucesso (verde) fecha sozinho em 5 s, como o `Toast duration={5000}`;
// - erro (vermelho) fica até "Dispensar" ou até a próxima ação, com a mensagem decidida pelo
//   `code` (`describeError`) — nunca `err.message` cru nem "Erro… Tente novamente." fixo.
// Só uma mensagem por vez: o valor é controlado e uma nova substitui a anterior.

import { useCallback, useEffect, useRef, useState } from 'react';

import { DsButton } from './DsButton';
import { useElementEvent } from './use-custom-element';

import { ACTION_LABELS } from '@/lib/errors/actions';
import { bannerAction, describeBannerError } from '@/lib/errors/banner';
import type { DescribeErrorOptions } from '@/lib/errors/describe';

export const ACTION_FEEDBACK_SUCCESS_MS = 5000;
export const ACTION_FEEDBACK_ERROR_FALLBACK = 'Não foi possível concluir a ação. Tente de novo.';

export type ActionFeedbackValue =
  | { tone: 'success'; message: string }
  | {
      tone: 'critical';
      /** Erro capturado (passa por `describeError`) ou frase em português exibida como está. */
      error: unknown;
      /** Texto quando o erro não tem status nem código conhecido. */
      fallbackMessage?: string;
      /** Ação "Tentar de novo" (só aparece se o erro pedir repetir). */
      onRetry?: () => void;
      /** Frase em português antes da mensagem do erro (ex.: quantos itens de um lote foram aplicados). */
      summary?: string;
    };

export interface ActionFeedbackProps {
  feedback: ActionFeedbackValue | null;
  onDismiss: () => void;
  /** Tempo até o sucesso fechar sozinho (padrão 5 s). */
  successMs?: number;
  /** Mensagens de um módulo registrado (`registerErrorMessages`). */
  module?: string;
  hrefs?: DescribeErrorOptions['hrefs'];
}

export function ActionFeedback({
  feedback,
  onDismiss,
  successMs = ACTION_FEEDBACK_SUCCESS_MS,
  module,
  hrefs,
}: ActionFeedbackProps): JSX.Element {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  // Sucesso fecha sozinho; cada novo valor reinicia o relógio (a nova mensagem substitui a antiga).
  useEffect(() => {
    if (!feedback || feedback.tone !== 'success') return undefined;
    const timer = setTimeout(() => dismissRef.current(), successMs);
    return () => clearTimeout(timer);
  }, [feedback, successMs]);

  // As duas regiões ficam sempre montadas: o leitor de tela anuncia cada mensagem nova. Sucesso em
  // `role="status"` (educado); erro em `role="alert"` (anunciado na hora, inclusive quando um modal
  // acabou de fechar e devolveu o foco ao botão que o abriu — o foco nunca é movido para o banner).
  const banner = feedback ? <FeedbackBanner feedback={feedback} onDismiss={onDismiss} module={module} hrefs={hrefs} /> : null;
  const isError = feedback?.tone === 'critical';
  // Story 20.5f — `ds-live-region` (display: contents): vazias, as regiões não geram caixa, então
  // não somam o `gap` do `s-stack` (antes eram ~32px de vão entre o título e o conteúdo).
  return (
    <>
      <div className="ds-live-region" role="status" aria-live="polite" data-testid="action-feedback-region">
        {isError ? null : banner}
      </div>
      <div className="ds-live-region" role="alert" data-testid="action-feedback-alert">
        {isError ? banner : null}
      </div>
    </>
  );
}

/** O banner monta junto com a mensagem, para o listener de `dismiss` (X) ser registrado nele. */
function FeedbackBanner({
  feedback,
  onDismiss,
  module,
  hrefs,
}: {
  feedback: ActionFeedbackValue;
  onDismiss: () => void;
  module?: string;
  hrefs?: DescribeErrorOptions['hrefs'];
}): JSX.Element {
  const ref = useRef<HTMLElementTagNameMap['s-banner']>(null);
  useElementEvent(ref, 'dismiss', onDismiss);

  if (feedback.tone === 'success') {
    return (
      <s-banner ref={ref} tone="success" dismissible data-testid="action-feedback">
        {feedback.message}
      </s-banner>
    );
  }

  const { message, info } = describeBannerError(feedback.error, {
    module,
    hrefs,
    fallback: feedback.fallbackMessage ?? ACTION_FEEDBACK_ERROR_FALLBACK,
  });
  const action = bannerAction(info, { onRetry: feedback.onRetry }, ACTION_LABELS, { reloadFallback: false });
  return (
    <s-banner ref={ref} tone="critical" dismissible data-testid="action-feedback">
      {feedback.summary ? `${feedback.summary} ` : null}
      {message}
      {info?.correlationId ? (
        <s-text color="subdued" data-testid="support-code">
          {' '}Código para suporte: {info.correlationId}
        </s-text>
      ) : null}
      {action ? (
        <DsButton slot="secondary-actions" variant="secondary" onClick={action.onClick} href={action.href}>
          {action.label}
        </DsButton>
      ) : null}
      <DsButton slot="secondary-actions" variant="tertiary" onClick={onDismiss}>
        Dispensar
      </DsButton>
    </s-banner>
  );
}

export interface ActionFeedbackState {
  feedback: ActionFeedbackValue | null;
  success: (message: string) => void;
  failure: (error: unknown, options?: { fallbackMessage?: string; onRetry?: () => void; summary?: string }) => void;
  dismiss: () => void;
}

/** Estado de uma mensagem por vez para o `ActionFeedback`. */
export function useActionFeedback(): ActionFeedbackState {
  const [feedback, setFeedback] = useState<ActionFeedbackValue | null>(null);
  const success = useCallback((message: string) => setFeedback({ tone: 'success', message }), []);
  const failure = useCallback(
    (error: unknown, options: { fallbackMessage?: string; onRetry?: () => void; summary?: string } = {}) =>
      setFeedback({ tone: 'critical', error, ...options }),
    [],
  );
  const dismiss = useCallback(() => setFeedback(null), []);
  return { feedback, success, failure, dismiss };
}

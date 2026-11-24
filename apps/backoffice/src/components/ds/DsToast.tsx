'use client';

// Stories 20.11b/c/d — o estado de "toast" das telas (`{ content, error? }`, ex.: `useToast` do VSL)
// mostrado com o `ActionFeedback` do DS (o `Toast` do Polaris React não existe nos Web Components
// fora do admin da Shopify). Mesmo texto; sucesso fecha sozinho em 5 s, como o `Toast`; erro fica até
// "Dispensar" (frase em português exibida como está). Só renderiza com mensagem.

import { useMemo } from 'react';

import { ActionFeedback, type ActionFeedbackValue } from './ActionFeedback';

export interface DsToastState {
  content: string;
  error?: boolean;
}

export interface DsToastProps {
  toast: DsToastState | null;
  onDismiss: () => void;
}

export function DsToast({ toast, onDismiss }: DsToastProps): JSX.Element | null {
  // Memo pelo próprio objeto do estado: re-renderizar a tela não reinicia o relógio dos 5 s.
  const feedback = useMemo<ActionFeedbackValue | null>(
    () => (toast ? (toast.error ? { tone: 'critical', error: toast.content } : { tone: 'success', message: toast.content }) : null),
    [toast],
  );
  if (!feedback) return null;
  return <ActionFeedback feedback={feedback} onDismiss={onDismiss} />;
}

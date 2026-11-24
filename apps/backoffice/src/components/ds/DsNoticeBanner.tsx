'use client';

// Story 20.15b — aviso simples (`s-banner`) com o texto da tela e, se a tela passar `onDismiss`, o "x" de
// fechar (evento `dismiss` do elemento — o React 18 não liga `onDismiss` em custom elements). No lugar do
// `Banner` do Polaris React com `tone` + `onDismiss`: fica até a pessoa fechar (não some sozinho).

import { useRef, type ReactNode } from 'react';

import { useElementEvent } from './use-custom-element';

export interface DsNoticeBannerProps {
  tone?: 'info' | 'success' | 'warning' | 'critical';
  children: ReactNode;
  onDismiss?: () => void;
  testId?: string;
}

export function DsNoticeBanner({ tone = 'info', children, onDismiss, testId }: DsNoticeBannerProps): JSX.Element {
  const ref = useRef<HTMLElementTagNameMap['s-banner']>(null);
  useElementEvent(ref, 'dismiss', () => onDismiss?.());
  return (
    <div data-testid={testId}>
      <s-banner ref={ref} tone={tone} dismissible={onDismiss ? true : undefined}>
        {children}
      </s-banner>
    </div>
  );
}

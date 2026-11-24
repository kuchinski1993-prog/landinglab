'use client';

// Story 20.15a — aviso com título, texto e ação (`s-banner`), no lugar do `AlertBanner` do TrustShield
// (Polaris React `Banner`). O título vai no conteúdo (`s-heading`), não no atributo `heading`: fica no
// DOM da página (leitores de tela, busca e testes acham o texto como antes). A ação é um botão do DS no
// slot `secondary-actions` (mesmo handler da tela). Só apresentação.

import type { ReactNode } from 'react';

import { DsButton } from './DsButton';

export interface DsAlertBannerProps {
  tone?: 'info' | 'success' | 'warning' | 'critical';
  title?: string;
  children?: ReactNode;
  /** Ação de resolução ("Ver agora"): mesmo texto e mesmo handler de antes. */
  action?: { content: string; onAction: () => void };
  testId?: string;
}

export function DsAlertBanner({ tone = 'info', title, children, action, testId }: DsAlertBannerProps): JSX.Element {
  return (
    <s-banner tone={tone} data-testid={testId}>
      <s-stack gap="small-100">
        {title ? <s-heading>{title}</s-heading> : null}
        {children ? <s-paragraph>{children}</s-paragraph> : null}
      </s-stack>
      {action ? (
        <DsButton slot="secondary-actions" variant="secondary" onClick={action.onAction}>
          {action.content}
        </DsButton>
      ) : null}
    </s-banner>
  );
}

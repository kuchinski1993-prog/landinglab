'use client';

// @ds-migrated — Story 20.10c (PR B): aviso de erro das ações de domínio no design system.
//
// Mesmas regras do `ErrorBanner` legado com `describe={describeDomainError}` (Story 18.10a/b): a
// mensagem e a ação vêm de `describeDomainError` (texto curado da rota no 4xx, genérica por status no
// 5xx/HTML, "Sem conexão…" na rede, "Entrar de novo" no 401) e o "Tentar de novo" só aparece com
// `onRetry`. O botão mostra "Tentar de novo" e o nome acessível diz QUAL ação (`retryLabel`).
// Envolto em `role="alert"` (anúncio imediato), como o banner crítico do Polaris React.

import { useRef } from 'react';

import { describeDomainError } from '../_lib/domain-response';

import { DsButton, useElementEvent } from '@/components/ds';
import { ACTION_LABELS } from '@/lib/errors/actions';
import { bannerAction } from '@/lib/errors/banner';

export interface DomainErrorBannerProps {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  /** Nome acessível do "Tentar de novo" (ex.: "Tentar de novo: remover domínio x.com"). */
  retryLabel?: string;
  onDismiss?: () => void;
}

export function DomainErrorBanner({ error, title, onRetry, retryLabel, onDismiss }: DomainErrorBannerProps): JSX.Element {
  const ref = useRef<HTMLElementTagNameMap['s-banner']>(null);
  useElementEvent(ref, 'dismiss', onDismiss);
  const info = describeDomainError(error);
  const action = bannerAction(info, { onRetry }, ACTION_LABELS, { reloadFallback: false });
  return (
    <div role="alert">
      <s-banner ref={ref} tone="critical" heading={title}>
        {info.message}
        {info.correlationId ? (
          <s-text color="subdued" data-testid="support-code">
            {' '}Código para suporte: {info.correlationId}
          </s-text>
        ) : null}
        {action ? (
          <DsButton
            slot="secondary-actions"
            variant="secondary"
            onClick={action.onClick}
            href={action.href}
            accessibilityLabel={action.label === ACTION_LABELS.retry && retryLabel ? retryLabel : undefined}
          >
            {action.label}
          </DsButton>
        ) : null}
        {onDismiss ? (
          <DsButton slot="secondary-actions" variant="tertiary" onClick={onDismiss}>
            Dispensar
          </DsButton>
        ) : null}
      </s-banner>
    </div>
  );
}

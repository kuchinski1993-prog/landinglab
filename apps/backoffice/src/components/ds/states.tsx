'use client';

// Story 20.1 (AC10) — estados compartilhados no visual novo (Polaris Web
// Components), com a MESMA API (props) de `ErrorBanner`/`EmptyBlock`/
// `LoadingCard`/`ConfirmModal` usada hoje em `vsl/_components/shared.tsx`
// (evoluídos pela 18.1b: ErrorBanner decide o botão pelo `code`; StateBoundary).
// Só para telas migradas (dentro do <PolarisGate>). A versão em Polaris React (o "legacy" da 18.1b)
// saiu na 20.13a: `vsl/_components/shared.tsx` reexporta estes.

import { useRef, useState, type ReactNode } from 'react';

import { DsButton } from './DsButton';
import { DsModal } from './DsModal';
import { useElementEvent } from './use-custom-element';

import { DEFAULT_SLOW_AFTER_MS, useSlowTimer } from '@/hooks/useSlowTimer';
import { ACTION_LABELS } from '@/lib/errors/actions';
import { bannerAction, describeBannerError, type BannerLabels } from '@/lib/errors/banner';
import type { DescribeErrorOptions, ErrorInfo } from '@/lib/errors/describe';


export const DEFAULT_ERROR_MESSAGE = 'Não foi possível carregar os dados. Tente de novo em instantes.';
export const SLOW_LOADING_MESSAGE = 'Está demorando mais que o normal.';

export interface ErrorBannerProps {
  /**
   * Texto em português (exibido como está) ou o erro capturado: `ApiError`/`Error` passam por
   * `describeError`, que decide a mensagem e o botão pelo `code`. Mensagens cruas nunca aparecem.
   */
  error: unknown;
  title?: string;
  onRetry?: () => void;
  onReload?: () => void;
  onDismiss?: () => void;
  /** Story 18.1b — texto quando o erro não tem status nem código conhecido. */
  fallbackMessage?: string;
  /** Story 18.1b — rótulo do botão de tentar de novo (padrão "Tentar de novo"). */
  retryLabel?: string;
  /** Story 18.1b — mensagens de um módulo registrado (`registerErrorMessages`). */
  module?: string;
  /** Story 18.1b — endereços de ações `link` que dependem da tela. */
  hrefs?: DescribeErrorOptions['hrefs'];
  /** Stories 20.11b/c/d — rótulos próprios de um módulo (ex.: VSL: "Tentar novamente"/"Fazer login"). */
  labels?: Partial<BannerLabels>;
  /**
   * Stories 20.11b/c/d — regra própria de um módulo (ex.: VSL, `describeVslErrorInfo`), como no
   * `ErrorBanner` antigo em Polaris React (18.1b): mensagem e botão decididos por ela, sem o
   * "Recarregar" de reserva.
   */
  describe?: (error: unknown) => ErrorInfo;
}

function SupportCode({ id }: { id: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) return; // sem clipboard: o código continua visível e selecionável
    clipboard.writeText(id).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-text color="subdued" data-testid="support-code">
        Código para suporte: {id}
      </s-text>
      <DsButton variant="tertiary" onClick={copy} accessibilityLabel="Copiar código para suporte">
        {copied ? 'Copiado' : 'Copiar'}
      </DsButton>
    </s-stack>
  );
}

/** Banner crítico com mensagem em português e a ação de recuperação certa para o erro. */
export function ErrorBanner({
  error,
  title,
  onRetry,
  onReload,
  onDismiss,
  fallbackMessage,
  retryLabel,
  module,
  hrefs,
  labels,
  describe,
}: ErrorBannerProps): JSX.Element {
  const ref = useRef<HTMLElementTagNameMap['s-banner']>(null);
  useElementEvent(ref, 'dismiss', onDismiss);
  const own = describe ? describe(error) : null;
  const { message, info } = own ? { message: own.message, info: own } : describeBannerError(error, { module, hrefs, fallback: fallbackMessage ?? DEFAULT_ERROR_MESSAGE });
  const action = bannerAction(
    info,
    { onRetry, onReload },
    { ...ACTION_LABELS, ...labels, retry: retryLabel ?? labels?.retry ?? ACTION_LABELS.retry },
    describe ? { reloadFallback: false } : undefined,
  );
  return (
    <s-banner ref={ref} tone="critical" heading={title} dismissible={onDismiss ? true : undefined}>
      {message}
      {info?.correlationId ? <SupportCode id={info.correlationId} /> : null}
      {action ? (
        <DsButton slot="secondary-actions" variant="secondary" onClick={action.onClick} href={action.href}>
          {action.label}
        </DsButton>
      ) : null}
    </s-banner>
  );
}

export function EmptyBlock({
  heading,
  children,
  action,
}: {
  heading: string;
  children?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <s-box background="subdued" padding="large-200" borderRadius="base">
      <s-stack gap="small-200" alignItems="center">
        <s-heading>{heading}</s-heading>
        {children ? <s-paragraph color="subdued">{children}</s-paragraph> : null}
        {action ? <s-stack direction="inline" justifyContent="center">{action}</s-stack> : null}
      </s-stack>
    </s-box>
  );
}

export function LoadingCard({ lines = 4, heading = true }: { lines?: number; heading?: boolean }): JSX.Element {
  return (
    <s-section>
      <div aria-busy="true" className="ds-skeleton-card" data-testid="ds-loading-card">
        {heading ? <span className="ds-skeleton-line ds-skeleton-line--heading" /> : null}
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className={i === lines - 1 ? 'ds-skeleton-line ds-skeleton-line--short' : 'ds-skeleton-line'} />
        ))}
      </div>
    </s-section>
  );
}

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}

/** Modal de confirmação padrão (ações destrutivas e de produção). */
export function ConfirmModal({
  open,
  title,
  confirmLabel,
  destructive,
  loading,
  disabled,
  onConfirm,
  onClose,
  children,
}: ConfirmModalProps): JSX.Element {
  return (
    <DsModal
      open={open}
      onClose={onClose}
      heading={title}
      primaryAction={{ content: confirmLabel, destructive, loading, disabled, onAction: onConfirm }}
      secondaryActions={[{ content: 'Cancelar', onAction: onClose, disabled: loading }]}
    >
      <s-stack gap="base">{children}</s-stack>
    </DsModal>
  );
}

export type StateBoundaryStatus = 'loading' | 'error' | 'empty' | 'ready';

/** Vazio sempre diz o que falta (`heading`) e o próximo passo (`children`). */
export interface StateBoundaryEmpty {
  heading: string;
  children: ReactNode;
  action?: ReactNode;
}

export interface StateBoundaryProps {
  status: StateBoundaryStatus;
  /** Erro capturado (ou frase em português) mostrado no `ErrorBanner` quando `status="error"`. */
  error?: unknown;
  errorTitle?: string;
  onRetry?: () => void;
  onReload?: () => void;
  /** Chamado uma vez quando o carregando passa de `slowAfterMs` (a tela pode abortar a busca com `useAsyncState().abort`, que vira erro com "Tentar de novo"). */
  onSlow?: () => void;
  /** Padrão 15 s. */
  slowAfterMs?: number;
  empty?: StateBoundaryEmpty;
  loadingLines?: number;
  /** Nome acessível do carregando (leitor de tela). Padrão "Carregando". */
  loadingLabel?: string;
  /** Mensagens de um módulo registrado (`registerErrorMessages`). */
  module?: string;
  children?: ReactNode;
}

/**
 * Story 18.1b — carregando / vazio / erro / pronto com a mesma cara em toda tela.
 * Sem `empty`, o estado vazio mostra os filhos (a tela trata o vazio dentro deles).
 */
export function StateBoundary({
  status,
  error,
  errorTitle,
  onRetry,
  onReload,
  onSlow,
  slowAfterMs = DEFAULT_SLOW_AFTER_MS,
  empty,
  loadingLines = 3,
  loadingLabel = 'Carregando',
  module,
  children,
}: StateBoundaryProps): JSX.Element {
  const slow = useSlowTimer(status === 'loading', slowAfterMs, onSlow);
  if (status === 'loading') {
    return (
      <div role="status" aria-live="polite" aria-label={loadingLabel}>
        <s-stack gap="base">
          {slow ? (
            <s-banner tone="warning" data-testid="state-slow">
              {SLOW_LOADING_MESSAGE}
              {onRetry ? (
                <DsButton slot="secondary-actions" variant="secondary" onClick={onRetry}>
                  {ACTION_LABELS.retry}
                </DsButton>
              ) : null}
            </s-banner>
          ) : null}
          <LoadingCard lines={loadingLines} />
        </s-stack>
      </div>
    );
  }
  if (status === 'error') return <ErrorBanner title={errorTitle} error={error} onRetry={onRetry} onReload={onReload} module={module} />;
  if (status === 'empty' && empty) {
    return (
      <EmptyBlock heading={empty.heading} action={empty.action}>
        {empty.children}
      </EmptyBlock>
    );
  }
  return <>{children}</>;
}

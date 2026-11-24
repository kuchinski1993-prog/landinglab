'use client';

// Story 20.1 — guarda de toda tela migrada para Polaris Web Components.
//
// • Servidor e 1º render do cliente mostram o esqueleto (mesmo HTML → sem
//   aviso de hidratação); os `s-*` só aparecem depois que o bundle registrou
//   os elementos.
// • Se o <script> falhar ou não registrar em 5 s: mensagem em português com
//   "Tentar de novo" (nunca tela branca).
// • Envolve tudo em `.ds-screen` (escopo dos tokens de ds-tokens.css).

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { POLARIS_WC_TIMEOUT_MS, reloadPolarisScript, waitForPolaris } from './polaris-loader';

export type PolarisGateStatus = 'loading' | 'ready' | 'failed';

export const POLARIS_LOAD_ERROR_MESSAGE =
  'Não foi possível carregar o visual do painel. Verifique sua conexão e tente de novo.';

export interface PolarisGateProps {
  children: ReactNode;
  /** Esqueleto enquanto o bundle carrega (padrão: 3 cartões). */
  fallback?: ReactNode;
  timeoutMs?: number;
}

export function GateSkeleton({ cards = 3 }: { cards?: number }): JSX.Element {
  return (
    <div className="ds-page-fallback" aria-busy="true" aria-live="polite" data-testid="ds-gate-loading">
      <span className="ds-skeleton-line ds-skeleton-line--heading" />
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="ds-skeleton-card">
          <span className="ds-skeleton-line ds-skeleton-line--heading" />
          <span className="ds-skeleton-line" />
          <span className="ds-skeleton-line ds-skeleton-line--short" />
        </div>
      ))}
    </div>
  );
}

export function PolarisGate({ children, fallback, timeoutMs = POLARIS_WC_TIMEOUT_MS }: PolarisGateProps): JSX.Element {
  const [status, setStatus] = useState<PolarisGateStatus>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const { promise, cancel } = waitForPolaris(timeoutMs);
    let alive = true;
    void promise.then((ok) => {
      if (alive) setStatus(ok ? 'ready' : 'failed');
    });
    return () => {
      alive = false;
      cancel();
    };
  }, [attempt, timeoutMs]);

  const retry = useCallback(() => {
    reloadPolarisScript();
    setStatus('loading');
    setAttempt((n) => n + 1);
  }, []);

  return (
    <div className="ds-screen" data-ds-status={status}>
      {status === 'ready' ? (
        children
      ) : status === 'failed' ? (
        <div className="ds-load-error" role="alert" data-testid="ds-gate-error">
          <p className="ds-load-error__title">O painel não carregou</p>
          <p className="ds-load-error__text">{POLARIS_LOAD_ERROR_MESSAGE}</p>
          <button type="button" className="ds-load-error__button" onClick={retry}>
            Tentar de novo
          </button>
        </div>
      ) : (
        (fallback ?? <GateSkeleton />)
      )}
    </div>
  );
}

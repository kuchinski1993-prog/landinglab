'use client';

// Stories 20.11c/d — o `SaveIndicator` (SM-4.7) no visual novo: mesmos estados e textos ("Salvando...",
// "Salvo há Xs/Xm/Xh", "Erro ao salvar" + "Tentar novamente", "Sem conexão. Salvo local."), mesma região
// viva (`role="status"`, `aria-live="polite"`), relógio de 10 s só no estado salvo. As funções de texto
// são as de `components/save-indicator-text` (reuso, sem cópia; antes em `components/SaveIndicator`).

import { useEffect, useState } from 'react';

import { DsButton } from './DsButton';

import { formatRelativeSaved, isLongSaved } from '@/components/save-indicator-text';
import type { SaveIndicatorState } from '@/hooks/useSaveIndicator';

export interface DsSaveIndicatorProps {
  state: SaveIndicatorState;
  lastSavedAt: number | null;
  onRetry?: () => void;
  nowFn?: () => number;
}

export function DsSaveIndicator({ state, lastSavedAt, onRetry, nowFn }: DsSaveIndicatorProps): JSX.Element {
  const [nowTick, setNowTick] = useState<number>(() => (nowFn ? nowFn() : Date.now()));

  useEffect(() => {
    if (state !== 'saved') return undefined;
    const now = (): number => (nowFn ? nowFn() : Date.now());
    setNowTick(now());
    const interval = setInterval(() => setNowTick(now()), 10_000);
    return () => clearInterval(interval);
  }, [state, nowFn, lastSavedAt]);

  let content: JSX.Element | null = null;
  if (state === 'saving') {
    content = (
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-spinner accessibilityLabel="Salvando" size="base" />
        <s-text color="subdued">Salvando...</s-text>
      </s-stack>
    );
  } else if (state === 'saved') {
    const long = lastSavedAt !== null && isLongSaved(lastSavedAt, nowTick);
    content = (
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-icon type="check-circle" tone={long ? 'neutral' : 'success'} />
        <s-text color={long ? 'subdued' : 'base'} tone={long ? 'neutral' : 'success'}>
          {lastSavedAt === null ? 'Salvo' : formatRelativeSaved(lastSavedAt, nowTick)}
        </s-text>
      </s-stack>
    );
  } else if (state === 'error') {
    content = (
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-icon type="alert-circle" tone="critical" />
        <s-text tone="critical">Erro ao salvar</s-text>
        {onRetry ? (
          <DsButton variant="tertiary" tone="critical" onClick={onRetry}>
            Tentar novamente
          </DsButton>
        ) : null}
      </s-stack>
    );
  } else if (state === 'offline') {
    content = (
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-icon type="alert-triangle" tone="caution" />
        <s-text tone="caution">Sem conexão. Salvo local.</s-text>
      </s-stack>
    );
  }

  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-testid="save-indicator">
      {content}
    </div>
  );
}

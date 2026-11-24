'use client';

// @ds-migrated — Story 20.10b: peças comuns das seções do editor no design system.
//
// `EditorCardHeader`: título da seção (s-heading), selos ao lado e a ação da seção à direita — o
// cabeçalho que cada seção repetia com Polaris React (sem os emojis de ícone, NFR-20.5).
// `EditorBanner`: aviso do DS com título opcional e fechar; sucesso/informação são anunciados com
// `role="status"` e erro com `role="alert"`.

import { useRef, type ReactNode } from 'react';

import { useElementEvent } from '@/components/ds';

export type EditorTone = 'success' | 'critical' | 'info' | 'warning';
export type LegacyBadgeTone = 'success' | 'critical' | 'info' | 'warning' | 'attention' | undefined;

/** Tons dos selos de antes (Polaris React) no s-badge: "attention" → "caution", sem tom → "neutral". */
export function badgeTone(tone: LegacyBadgeTone): 'success' | 'critical' | 'info' | 'warning' | 'caution' | 'neutral' {
  if (tone === 'attention') return 'caution';
  return tone ?? 'neutral';
}

export function EditorCardHeader({ title, badges, action }: { title: string; badges?: ReactNode; action?: ReactNode }): JSX.Element {
  return (
    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-heading>{title}</s-heading>
        {badges}
      </s-stack>
      {action}
    </s-stack>
  );
}

export function EditorBanner({
  tone,
  title,
  children,
  onDismiss,
}: {
  tone: EditorTone;
  title?: string;
  children: ReactNode;
  onDismiss?: () => void;
}): JSX.Element {
  const ref = useRef<HTMLElementTagNameMap['s-banner']>(null);
  useElementEvent(ref, 'dismiss', onDismiss);
  return (
    <div role={tone === 'critical' ? 'alert' : 'status'}>
      <s-banner ref={ref} tone={tone} heading={title} dismissible={onDismiss ? true : undefined}>
        {children}
      </s-banner>
    </div>
  );
}

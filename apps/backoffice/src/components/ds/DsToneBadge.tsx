'use client';

// Story 20.15a — selo (`s-badge`) a partir dos tons do Polaris React que os dicionários do painel usam
// (`LabelTone` de `lib/labels/pt-BR`: success/warning/critical/info/attention). O `s-badge` não tem
// `attention`: vira `caution` (amarelo), o equivalente visual. Sem tom = selo neutro. Só apresentação:
// texto e tom continuam vindo do dicionário/da tela.

import type { ReactNode } from 'react';

export type DsToneBadgeTone = 'success' | 'warning' | 'critical' | 'info' | 'attention' | 'new' | 'neutral' | null | undefined;

export interface DsToneBadgeProps {
  tone?: DsToneBadgeTone;
  children: ReactNode;
}

type BadgeElementTone = 'success' | 'warning' | 'critical' | 'info' | 'caution' | 'neutral' | undefined;

function badgeTone(tone: DsToneBadgeTone): BadgeElementTone {
  if (tone === 'attention') return 'caution';
  if (tone === 'new') return 'info';
  if (!tone) return undefined;
  return tone;
}

export function DsToneBadge({ tone, children }: DsToneBadgeProps): JSX.Element {
  return <s-badge tone={badgeTone(tone)}>{children}</s-badge>;
}

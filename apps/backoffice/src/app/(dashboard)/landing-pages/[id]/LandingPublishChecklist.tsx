'use client';

// @ds-migrated — Story 20.13b (PR D): checklist no design system (s-badge pelo DsToneBadge, s-text).
//
// Story 0.6 (AC6) — checklist de pré-publicação da landing. Mesmo visual do
// checklist do VSL (vsl/_components/PublishChecklist.tsx): bloqueantes primeiro,
// depois avisos; cada pendência mostra a ação para corrigir.

import { DsToneBadge } from '@/components/ds';
import type { LandingPublishCheckItem } from '@/lib/landing-publish-check';

interface Props {
  items: LandingPublishCheckItem[];
  /** Mostrar também os itens ok. Padrão: só pendências. */
  showOk?: boolean;
}

export default function LandingPublishChecklist({ items, showOk = false }: Props): JSX.Element | null {
  const blocking = items.filter((i) => !i.ok && i.severity === 'blocking');
  const warnings = items.filter((i) => !i.ok && i.severity === 'warning');
  const ok = showOk ? items.filter((i) => i.ok) : [];
  const ordered = [...blocking, ...warnings, ...ok];
  if (ordered.length === 0) return null;

  return (
    <div role="list" aria-label="Checklist de publicação">
      {ordered.map((item, index) => (
        <div role="listitem" key={`${item.code}-${index}`}>
          <s-box paddingBlock="small-200" borderStyle="none none solid none" border="base">
            <s-stack gap="small-500">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <DsToneBadge tone={item.ok ? 'success' : item.severity === 'warning' ? 'warning' : 'critical'}>
                  {item.ok ? 'Ok' : item.severity === 'warning' ? 'Aviso' : 'Impede publicar'}
                </DsToneBadge>
                <s-text>{item.message}</s-text>
              </s-stack>
              {!item.ok && item.fixHint ? <s-text color="subdued">Como resolver: {item.fixHint}</s-text> : null}
            </s-stack>
          </s-box>
        </div>
      ))}
    </div>
  );
}

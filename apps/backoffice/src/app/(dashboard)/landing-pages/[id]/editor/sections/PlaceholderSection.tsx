'use client';

// @ds-migrated — Story 20.10b (PR2): cartão "em breve" no design system.
//
// PlaceholderSection — card de seção "em breve" (Wave A → Wave B).
// Consistente com as seções funcionais mas com botão desabilitado. O ícone (emoji) não aparece mais
// (NFR-20.5); a prop continua aceita para não mudar quem chama.

import { EditorCardHeader } from '../_components/EditorCard';

import { DsButton } from '@/components/ds';

interface Props {
  icon: string;
  title: string;
  description: string;
  reason: string;
}

export default function PlaceholderSection({ title, description, reason }: Props): JSX.Element {
  return (
    <s-section>
      <s-stack gap="small-200">
        <EditorCardHeader
          title={title}
          badges={<s-badge tone="caution">{reason}</s-badge>}
          action={
            <DsButton variant="secondary" disabled>
              Editar
            </DsButton>
          }
        />
        <s-paragraph color="subdued">{description}</s-paragraph>
      </s-stack>
    </s-section>
  );
}

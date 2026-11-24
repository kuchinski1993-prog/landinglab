'use client';

// @ds-migrated — Story 20.10b (PR2): aviso da prévia no design system (s-banner), mesmos textos e regra.
//
// Banner informativo pré-clique de preview.
//
// Contextualiza o que o usuário vai ver ao abrir o /preview endpoint. Como o
// preview serve sempre o htmlBody atual (draft), o comportamento visual pode
// divergir da versão publicada quando há edições posteriores ao publishedAt.
// Este banner alinha expectativa antes do clique.

interface Props {
  landing: {
    id: string;
    status: string;
    publishedAt: string | null;
    updatedAt: string;
  };
}

export default function PreviewInfoBanner({ landing }: Props): JSX.Element {
  if (landing.status === 'published') {
    // Compare ISO strings: lexicographic order == chronological order pra ISO 8601.
    const hasUnpublishedChanges =
      landing.publishedAt !== null && landing.updatedAt > landing.publishedAt;

    if (hasUnpublishedChanges) {
      return (
        <s-banner tone="warning">
          Há alterações não publicadas. O preview mostra a versão atual do rascunho — a versão ao
          vivo pode ser diferente.
        </s-banner>
      );
    }

    return (
      <s-banner tone="info">
        Esta landing está publicada. O preview mostra a versão ao vivo.
      </s-banner>
    );
  }

  // status === 'draft' (ou qualquer não-published)
  if (landing.publishedAt) {
    return (
      <s-banner tone="warning">
        Esta landing estava publicada e voltou para rascunho. O preview mostra o rascunho atual.
      </s-banner>
    );
  }

  return (
    <s-banner tone="info">
      Rascunho — não está ao vivo. O preview mostra como ficará ao publicar.
    </s-banner>
  );
}

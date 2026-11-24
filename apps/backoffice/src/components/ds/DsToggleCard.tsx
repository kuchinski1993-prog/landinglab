'use client';

// @ds-migrated — Story 20.10c: cartão-botão de alternância (ex.: "Gerar do zero" × "Clonar existente").
//
// O DS não tem um "cartão selecionável" grande: `s-press-button` é um botão de linha e `s-clickable`
// não expõe `aria-pressed`. Este é um <button> nativo (foco do teclado, Enter/Espaço, `aria-pressed`)
// com o visual dos cartões do DS (`.ds-toggle-card` em ds-tokens.css): borda, raio e fundo dos tokens,
// borda de destaque e fundo informativo quando ativo, contorno de foco visível. O título vem em negrito
// do DS (`s-text type="strong" fontWeight="bold"`) e a descrição em `subdued`.

export interface DsToggleCardProps {
  title: string;
  description?: string;
  pressed: boolean;
  onClick: () => void;
  disabled?: boolean;
}

export function DsToggleCard({ title, description, pressed, onClick, disabled = false }: DsToggleCardProps): JSX.Element {
  return (
    <button type="button" className="ds-toggle-card" aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <s-text type="strong" fontWeight="bold">
        {title}
      </s-text>
      {description ? <s-text color="subdued">{description}</s-text> : null}
    </button>
  );
}

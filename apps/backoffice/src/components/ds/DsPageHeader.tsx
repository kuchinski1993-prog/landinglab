'use client';

// @ds-migrated — Story 20.5f: cabeçalho de página com ações (título + ações na MESMA linha, dentro
// da coluna do conteúdo).
//
// Fora do admin da Shopify, as ações dos slots `primary-action`/`secondary-actions` do `s-page` vão
// para a barra fixa do topo, que ocupa a largura inteira da área (acima do título, encostando na
// borda direita). Telas com ações ou breadcrumb usam este cabeçalho dentro de um `<s-page>` SEM
// `heading`: título (h1, mesmo estilo do título do s-page — `.ds-page-title` em ds-tokens.css),
// ações alinhadas à direita na mesma linha, e — padrão do Shopify Admin — com mais de
// `MAX_INLINE_SECONDARY` ações secundárias só a primária fica visível e as secundárias vão para o
// menu "Mais ações" (`s-menu`). As ações são os mesmos elementos (mesmos handlers), só mudam de lugar.

import { Children, isValidElement, useId, type ReactNode } from 'react';

/** Até 2 secundárias ficam visíveis ao lado da primária; a partir de 3, todas vão para "Mais ações". */
export const MAX_INLINE_SECONDARY = 2;
export const MORE_ACTIONS_LABEL = 'Mais ações';

export interface DsPageHeaderProps {
  title: string;
  /** Link de volta (ex.: "Produtos") acima do título. */
  breadcrumb?: ReactNode;
  /** Ação primária (um `DsButton variant="primary"`). */
  primaryAction?: ReactNode;
  /** Ações secundárias (`DsButton`s, sem `slot`). Itens `null`/`false` são ignorados. */
  secondaryActions?: ReactNode;
  /** Selo/indicador ao lado do título (opcional). */
  accessory?: ReactNode;
}

export function DsPageHeader({ title, breadcrumb, primaryAction, secondaryActions, accessory }: DsPageHeaderProps): JSX.Element {
  const menuId = `page-actions-${useId().replace(/:/g, '')}`;
  const secondary = Children.toArray(secondaryActions).filter((c) => isValidElement(c));
  const useMenu = secondary.length > MAX_INLINE_SECONDARY;
  const hasActions = Boolean(primaryAction) || secondary.length > 0;

  return (
    <div className="ds-page-header" data-testid="page-header">
      {breadcrumb ? <div className="ds-page-header__breadcrumb">{breadcrumb}</div> : null}
      <div className="ds-page-header__row">
        <div className="ds-page-header__title">
          <h1 className="ds-page-title">{title}</h1>
          {accessory}
        </div>
        {hasActions ? (
          <div className="ds-page-header__actions" data-testid="page-header-actions">
            {useMenu ? (
              <>
                <s-button commandFor={menuId} icon="menu-horizontal" data-testid="page-more-actions">
                  {MORE_ACTIONS_LABEL}
                </s-button>
                <s-menu id={menuId} accessibilityLabel={MORE_ACTIONS_LABEL} data-testid="page-more-actions-menu">
                  {secondary}
                </s-menu>
              </>
            ) : (
              secondary
            )}
            {primaryAction}
          </div>
        ) : null}
      </div>
    </div>
  );
}

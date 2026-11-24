'use client';

// @ds-migrated — Story 20.5g: página larga do DS para listas com muitas colunas (padrão do Shopify Admin
// para listas largas, ex.: Produtos).
//
// Por que um componente: o `s-page` largo (`inlineSize="large"`) foi feito para rodar dentro do admin da
// Shopify, que já tem a moldura dele. Fora do admin, medido no navegador (Polaris 2, bundle da CDN):
//   • largura padrão: coluna fixa de 966px com 16px em cima e 32px de cada lado — em 1920px sobra meia
//     tela vazia e uma tabela de 10 colunas não cabe;
//   • `inlineSize="large"`: a coluna ocupa a área toda, mas com só 16px à esquerda, 4px à direita e 0 em
//     cima — conteúdo e botões encostam na borda direita da janela.
// Este wrapper usa o modo largo e devolve o respiro da largura padrão (16px em cima, 32px de cada lado),
// num lugar só. O título continua vindo do `DsPageHeader` (h1 `.ds-page-title`, 26px/700) — o `s-page`
// não recebe `heading`, então o título da barra do modo largo (13px) nunca aparece.
// Use `<s-page>` direto nas telas de largura padrão; `<s-page inlineSize="large">` só por aqui (guarda em
// `page-titles-standard.test.ts`).

import type { ReactNode } from 'react';

export interface DsWidePageProps {
  children: ReactNode;
}

export function DsWidePage({ children }: DsWidePageProps): JSX.Element {
  return (
    <div className="ds-page-wide" data-testid="ds-wide-page">
      <s-page inlineSize="large">{children}</s-page>
    </div>
  );
}

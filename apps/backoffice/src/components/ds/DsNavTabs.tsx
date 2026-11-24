'use client';

// Story 20.15a — barra do menu interno de uma área do painel (ex.: TrustShield): marca à esquerda, abas
// no meio e ações (ex.: sino) à direita. As abas são links da própria tela (Next <Link> = <a href>,
// Ctrl/Cmd-clique abre em nova aba) com as classes `ds-nav-tabs__tab` (+ `--active` e
// `aria-current="page"` na ativa). Só apresentação: destinos e aba ativa continuam decididos pela tela.
// Sem `.ds-screen` no seletor das classes: o menu fica no layout, fora do PolarisGate da página.

import type { ReactNode } from 'react';

export interface DsNavTabsProps {
  /** Nome acessível do <nav> (ex.: "Navegação do TrustShield"). */
  label: string;
  /** Marca/nome da área, à esquerda das abas. */
  brand?: ReactNode;
  /** Ações à direita (ex.: sino de notificações). */
  actions?: ReactNode;
  testId?: string;
  children: ReactNode;
}

export function DsNavTabs({ label, brand, actions, testId, children }: DsNavTabsProps): JSX.Element {
  return (
    <nav aria-label={label} data-testid={testId} className="ds-nav-tabs">
      <div className="ds-nav-tabs__start">
        {brand ? <span className="ds-nav-tabs__brand">{brand}</span> : null}
        <div className="ds-nav-tabs__list">{children}</div>
      </div>
      {actions ? <div className="ds-nav-tabs__actions">{actions}</div> : null}
    </nav>
  );
}

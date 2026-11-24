'use client';

// Story 20.10d (PR B) — link primário de uma linha clicável (`s-table-row clickDelegate={id}`), com o
// `useRowLink` já ligado: clique simples chama `onNavigate` (router) uma vez; Ctrl/Cmd/Shift/botão do
// meio abrem o `href` em nova aba. Mesmo padrão das linhas de Pedidos/Produtos (20.5e/20.5h), em
// componente para telas que montam as linhas a partir de colunas (sem um componente de linha próprio).

import { useRef, type ReactNode } from 'react';

import { useRowLink } from './use-row-link';

export interface DsRowLinkProps {
  /** Id do link — o mesmo valor vai no `clickDelegate` do `s-table-row`. */
  id: string;
  href: string;
  /** Navegação SPA do clique simples (ex.: `() => router.push(href)`). */
  onNavigate: () => void;
  accessibilityLabel?: string;
  children: ReactNode;
}

export function DsRowLink({
  id,
  href,
  onNavigate,
  accessibilityLabel,
  children,
}: DsRowLinkProps): JSX.Element {
  const ref = useRef<HTMLElementTagNameMap['s-link']>(null);
  useRowLink(ref, onNavigate);
  return (
    <s-link ref={ref} id={id} href={href} tone="neutral" accessibilityLabel={accessibilityLabel}>
      {children}
    </s-link>
  );
}

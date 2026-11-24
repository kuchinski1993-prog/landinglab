'use client';

// Story 20.2 — layout do painel: shell novo (menu Conta × Loja, seletor de
// loja, busca, menu mobile) em components/shell/AppShell.tsx. Os itens do menu
// vêm SÓ do registro em lib/nav/registry.ts.
//
// O `Frame` do Polaris React fica aqui, sem topo e sem menu, apenas como
// provedor de contexto das telas que ainda não migraram (Toast, Loading,
// ContextualSaveBar exigem um Frame acima). Sai na 20.last, junto com o
// Polaris React.

import { Frame } from '@shopify/polaris';
import type { ReactNode } from 'react';

import { AppShell } from '@/components/shell/AppShell';

export default function DashboardLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <AppShell>
      <Frame>{children}</Frame>
    </AppShell>
  );
}

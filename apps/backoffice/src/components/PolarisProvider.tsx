'use client';

import { AppProvider } from '@shopify/polaris';
import ptBR from '@shopify/polaris/locales/pt-BR.json';
import type { ReactNode } from 'react';

export default function PolarisProvider({ children }: { children: ReactNode }) {
  return (
    <AppProvider i18n={ptBR}>
      {children}
    </AppProvider>
  );
}

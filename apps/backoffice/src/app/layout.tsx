import type { ReactNode } from 'react';

import '@shopify/polaris/build/esm/styles.css';
import './globals.css';
import '@/styles/ds-tokens.css';
import { PolarisWebComponentsScript } from '@/components/ds/PolarisWebComponentsScript';
import PolarisProvider from '@/components/PolarisProvider';

export const metadata = {
  title: 'BlackShop',
  description: 'Single-user backoffice for e-commerce.',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="pt-BR">
      <head>
        {/* Story 20.1 — Polaris Web Components 2.x (único bundle; convive com o Polaris React). */}
        <PolarisWebComponentsScript />
      </head>
      <body className="min-h-screen antialiased">
        <PolarisProvider>{children}</PolarisProvider>
      </body>
    </html>
  );
}

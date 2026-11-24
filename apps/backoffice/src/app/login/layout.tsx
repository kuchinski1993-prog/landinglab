// Story 22.1b — telas de acesso: fora de buscadores (`noindex`) e sem `Referer` para fora (o link de
// criar senha leva um token; os cabeçalhos HTTP da rota ficam em next.config.mjs).
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Entrar — BlackShop',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function LoginLayout({ children }: { children: ReactNode }): JSX.Element {
  return <>{children}</>;
}

// Story 22.1b — `/criar-senha?token=…` é o caminho do link que a API (22.1a) manda por e-mail; mesma
// tela de /login/criar-senha. Fora de buscadores e sem `Referer` (T2).
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Criar senha — BlackShop',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function CriarSenhaLayout({ children }: { children: ReactNode }): JSX.Element {
  return <>{children}</>;
}

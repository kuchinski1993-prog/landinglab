import type { ReactNode } from 'react';

// Root layout mínimo. Cada landing traz seu próprio <style>/<link>/<meta>
// via extractHeadContent no page.tsx. Body sem estilos default pra evitar
// conflito com CSS da landing clonada.

export const metadata = {
  title: 'LandingLab',
  description: 'Landings publicadas via LandingLab.',
  robots: 'index, follow',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}

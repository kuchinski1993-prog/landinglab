'use client';

// @ds-migrated — Story 22.1b: moldura das telas de acesso, no visual do login da Shopify — fundo
// escuro em degradê, logo no canto superior esquerdo, cartão branco central e rodapé discreto; o
// CornerGlobe escuro (21.2a-v3) no canto superior direito, decorativo e atrás de tudo.
// HTML/CSS próprios (styles/auth.css): nada de Polaris — o login não depende do CDN (T4).

import '@/styles/auth.css';

import { useId, type ReactNode } from 'react';

import { Logo } from '@/components/Logo';
import { CornerGlobe } from '@/components/live/CornerGlobe';

export interface AuthScreenProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export function AuthScreen({ title, subtitle, children }: AuthScreenProps): JSX.Element {
  const titleId = useId();
  return (
    <div className="ds-auth" data-testid="auth-screen">
      <CornerGlobe placement="login" variant="dark" />
      <header className="ds-auth__brand">
        <Logo variant="full" tone="light" height={26} title="BlackShop" />
      </header>
      <main className="ds-auth__main">
        <section className="ds-auth-card" aria-labelledby={titleId}>
          <h1 id={titleId} className="ds-auth-card__title">
            {title}
          </h1>
          {subtitle ? <p className="ds-auth-card__subtitle">{subtitle}</p> : null}
          <div className="ds-auth-card__body">{children}</div>
        </section>
      </main>
      <footer className="ds-auth__footer">Acesso restrito a pessoas aprovadas pela BlackShop.</footer>
    </div>
  );
}

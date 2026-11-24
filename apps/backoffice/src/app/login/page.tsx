'use client';

// @ds-migrated — Story 22.1b: "Entrar" com e-mail e senha, no visual do login da Shopify
// (components/auth/AuthScreen). Comportamento herdado do login antigo (T10): foco inicial no
// primeiro campo, botão desabilitado com campo vazio, envio por Enter, `push` + `refresh` ao entrar.
// Qualquer 401 = "E-mail ou senha incorretos." (T3); envio único enquanto carrega (T5).
// Sem link para o acesso de emergência (T8).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { errorStatus, loginErrorMessage, normalizeEmail } from '@/components/auth/auth-messages';
import { AuthScreen } from '@/components/auth/AuthScreen';
import { AuthAlert, AuthPasswordField, AuthTextField } from '@/components/auth/fields';
import { useAfterLogin } from '@/components/auth/use-after-login';
import { apiClient } from '@/lib/api-client';
import { FORGOT_PATH, SIGNUP_PATH } from '@/lib/public-routes';

export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const afterLogin = useAfterLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Compatibilidade com a aba da story (`/login?aba=criar`) → tela própria de criar conta.
    if (new URLSearchParams(window.location.search).get('aba') === 'criar') {
      router.replace(SIGNUP_PATH);
      return;
    }
    emailRef.current?.focus();
    // Só ao montar (o foco inicial não pode voltar ao e-mail a cada render).
  }, []);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setSubmitting(true);
    try {
      await apiClient.post<{ status: string }>('/auth/login', { email: normalizeEmail(email), password });
      afterLogin();
    } catch (err) {
      // 401: a senha é apagada (digitar de novo); falha de rede/5xx: a senha fica.
      if (errorStatus(err) === 401) setPassword('');
      setError(loginErrorMessage(err));
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  return (
    <AuthScreen title="Entrar" subtitle="Continue para o painel BlackShop">
      <form className="ds-auth-form" onSubmit={(e) => void handleSubmit(e)} noValidate aria-label="Entrar">
        {error ? (
          <AuthAlert tone="critical" focusOnShow testId="login-error">
            {error}
          </AuthAlert>
        ) : null}
        <AuthTextField
          ref={emailRef}
          label="E-mail"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={setEmail}
          disabled={submitting}
          required
        />
        <AuthPasswordField
          label="Senha"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          disabled={submitting}
          required
        />
        <div className="ds-auth-row">
          <Link href={FORGOT_PATH} className="ds-auth-link">
            Esqueci minha senha
          </Link>
        </div>
        <button type="submit" className="ds-auth-button" disabled={!canSubmit}>
          {submitting ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
      <p className="ds-auth-switch">
        Novo por aqui?{' '}
        <Link href={SIGNUP_PATH} className="ds-auth-link">
          Criar conta →
        </Link>
      </p>
    </AuthScreen>
  );
}

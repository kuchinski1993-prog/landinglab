'use client';

// @ds-migrated — Story 22.1b (AC8, T8): acesso de emergência TEMPORÁRIO com a senha antiga
// (`POST /auth/login/emergency`, 22.1a). Só o campo senha; nenhum link aponta para cá (nem /login,
// nem menu, nem ajuda); `noindex` pelo layout de /login. Mesmas mensagens do login (401 genérico).
// Sai do repositório na 22.1d.

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { EMERGENCY_NOTICE, errorStatus, loginErrorMessage } from '@/components/auth/auth-messages';
import { AuthScreen } from '@/components/auth/AuthScreen';
import { AuthAlert, AuthPasswordField } from '@/components/auth/fields';
import { useAfterLogin } from '@/components/auth/use-after-login';
import { apiClient } from '@/lib/api-client';
import { LOGIN_PATH } from '@/lib/public-routes';

export default function EmergenciaPage(): JSX.Element {
  const afterLogin = useAfterLogin();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (password.length === 0 || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setSubmitting(true);
    try {
      await apiClient.post('/auth/login/emergency', { password });
      afterLogin();
    } catch (err) {
      if (errorStatus(err) === 401) setPassword('');
      setError(loginErrorMessage(err));
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  return (
    <AuthScreen title="Acesso de emergência" subtitle="Senha antiga do painel">
      <form className="ds-auth-form" onSubmit={(e) => void handleSubmit(e)} noValidate aria-label="Acesso de emergência">
        <AuthAlert tone="warning" testId="emergency-notice">
          {EMERGENCY_NOTICE}
        </AuthAlert>
        {error ? (
          <AuthAlert tone="critical" focusOnShow testId="emergency-error">
            {error}
          </AuthAlert>
        ) : null}
        <AuthPasswordField
          ref={passwordRef}
          label="Senha"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          disabled={submitting}
          required
        />
        <button type="submit" className="ds-auth-button" disabled={submitting || password.length === 0}>
          {submitting ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
      <p className="ds-auth-switch">
        <Link href={LOGIN_PATH} className="ds-auth-link">
          ← Entrar com e-mail e senha
        </Link>
      </p>
    </AuthScreen>
  );
}

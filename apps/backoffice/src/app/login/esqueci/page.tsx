'use client';

// @ds-migrated — Story 22.1b (AC5, T3): pedir o link para criar/redefinir a senha. A resposta é
// SEMPRE a mesma frase (a API responde 202 para qualquer e-mail). Depois de enviar, o botão espera
// 30 s com contagem (não substitui o limite da API).

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  EMAIL_INVALID,
  FORGOT_RECEIVED,
  REQUEST_FAILED,
  TOO_MANY_ATTEMPTS,
  errorStatus,
  isValidEmail,
  normalizeEmail,
} from '@/components/auth/auth-messages';
import { AuthScreen } from '@/components/auth/AuthScreen';
import { AuthAlert, AuthTextField } from '@/components/auth/fields';
import { apiClient } from '@/lib/api-client';
import { LOGIN_PATH } from '@/lib/public-routes';

const RESEND_WAIT_S = 30;

export default function EsqueciPage(): JSX.Element {
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [wait, setWait] = useState(0);
  const inFlight = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current || wait > 0) return;
    setError(null);
    if (!isValidEmail(email)) {
      setFieldError(EMAIL_INVALID);
      emailRef.current?.focus();
      return;
    }
    setFieldError(null);
    inFlight.current = true;
    setSubmitting(true);
    try {
      await apiClient.post('/auth/forgot', { email: normalizeEmail(email) });
      setSent(true);
      setWait(RESEND_WAIT_S);
    } catch (err) {
      setError(errorStatus(err) === 429 ? TOO_MANY_ATTEMPTS : REQUEST_FAILED);
    } finally {
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  const label = submitting ? 'Enviando…' : wait > 0 ? `Enviar de novo em ${wait} s` : sent ? 'Enviar de novo' : 'Enviar link';

  return (
    <AuthScreen title="Esqueci minha senha" subtitle="Enviaremos um link para criar uma nova senha">
      <form className="ds-auth-form" onSubmit={(e) => void handleSubmit(e)} noValidate aria-label="Esqueci minha senha">
        {sent ? (
          <AuthAlert tone="success" testId="forgot-received">
            {FORGOT_RECEIVED}
          </AuthAlert>
        ) : null}
        {error ? (
          <AuthAlert tone="critical" focusOnShow testId="forgot-error">
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
          error={fieldError}
          disabled={submitting}
          required
        />
        <button type="submit" className="ds-auth-button" disabled={submitting || wait > 0 || email.trim().length === 0}>
          {label}
        </button>
      </form>
      <p className="ds-auth-switch">
        <Link href={LOGIN_PATH} className="ds-auth-link">
          ← Voltar para Entrar
        </Link>
      </p>
    </AuthScreen>
  );
}

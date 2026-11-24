'use client';

// @ds-migrated — Story 22.1b (AC3, T3/T5): "Criar conta" é um PEDIDO de acesso. Qualquer 202 da API
// mostra a mesma confirmação (nunca diz se o e-mail já existia). Validação no cliente antes de enviar,
// erro por campo em `aria-describedby`; envio único (duplo clique = 1 requisição); campo-isca
// `website` invisível que vai junto (a API ignora o pedido) sem erro na tela.

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  EMAIL_INVALID,
  NAME_INVALID,
  REQUEST_FAILED,
  SIGNUP_INVALID,
  SIGNUP_RECEIVED,
  TOO_MANY_ATTEMPTS,
  errorStatus,
  isValidEmail,
  normalizeEmail,
} from '@/components/auth/auth-messages';
import { AuthScreen } from '@/components/auth/AuthScreen';
import { AuthAlert, AuthTextField } from '@/components/auth/fields';
import { apiClient } from '@/lib/api-client';
import { LOGIN_PATH } from '@/lib/public-routes';

const NOTE_MAX = 280;

function nameError(value: string): string | null {
  const length = [...value.trim()].length;
  return length >= 2 && length <= 120 ? null : NAME_INVALID;
}

export default function CriarContaPage(): JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [website, setWebsite] = useState('');
  const [errors, setErrors] = useState<{ name: string | null; email: string | null }>({ name: null, email: null });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const inFlight = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const noteId = 'signup-note';

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    setError(null);
    const next = { name: nameError(name), email: isValidEmail(email) ? null : EMAIL_INVALID };
    setErrors(next);
    if (next.name) {
      nameRef.current?.focus();
      return;
    }
    if (next.email) {
      emailRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    const trimmedNote = note.trim();
    try {
      await apiClient.post('/auth/signup', {
        name: name.trim(),
        email: normalizeEmail(email),
        ...(trimmedNote ? { note: trimmedNote.slice(0, NOTE_MAX) } : {}),
        ...(website ? { website } : {}),
      });
      setSent(true);
    } catch (err) {
      const status = errorStatus(err);
      setError(status === 429 ? TOO_MANY_ATTEMPTS : status === 400 ? SIGNUP_INVALID : REQUEST_FAILED);
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  if (sent) {
    return (
      <AuthScreen title="Pedido enviado" subtitle="Criar conta">
        <div className="ds-auth-form">
          <AuthAlert tone="success" testId="signup-received">
            {SIGNUP_RECEIVED}
          </AuthAlert>
          <Link href={LOGIN_PATH} className="ds-auth-button">
            Voltar para Entrar
          </Link>
        </div>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen title="Criar conta" subtitle="Peça acesso ao painel BlackShop">
      <form className="ds-auth-form" onSubmit={(e) => void handleSubmit(e)} noValidate aria-label="Criar conta">
        {error ? (
          <AuthAlert tone="critical" focusOnShow testId="signup-error">
            {error}
          </AuthAlert>
        ) : null}
        <AuthTextField
          ref={nameRef}
          label="Nome"
          name="name"
          autoComplete="name"
          value={name}
          onChange={setName}
          error={errors.name}
          disabled={submitting}
          required
        />
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
          error={errors.email}
          disabled={submitting}
          required
        />
        <div className="ds-auth-field">
          <label className="ds-auth-field__label" htmlFor={noteId}>
            Para que você precisa de acesso?<span className="ds-auth-field__optional"> (opcional)</span>
          </label>
          <textarea
            id={noteId}
            name="note"
            className="ds-auth-input"
            value={note}
            maxLength={NOTE_MAX}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            disabled={submitting}
            aria-describedby={`${noteId}-count`}
          />
          <p id={`${noteId}-count`} className="ds-auth-field__hint">
            {`${[...note].length} de ${NOTE_MAX} caracteres`}
          </p>
        </div>
        {/* Campo-isca: invisível para pessoas e leitores de tela; robôs preenchem. */}
        <div className="ds-auth-honeypot" aria-hidden="true">
          <label htmlFor="signup-website">Site</label>
          <input
            id="signup-website"
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>
        <button type="submit" className="ds-auth-button" disabled={submitting}>
          {submitting ? 'Enviando…' : 'Pedir acesso'}
        </button>
      </form>
      <p className="ds-auth-switch">
        Já tem conta?{' '}
        <Link href={LOGIN_PATH} className="ds-auth-link">
          Entrar →
        </Link>
      </p>
    </AuthScreen>
  );
}

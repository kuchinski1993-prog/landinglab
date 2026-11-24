'use client';

// @ds-migrated — Story 22.1b (AC6/AC7, T2/T9): criar ou redefinir a senha pelo link do e-mail.
//
// • O token sai da barra de endereço NO 1º RENDER (`history.replaceState`) e fica só em memória —
//   antes de qualquer requisição. Nunca vai para console, log, analytics nem query string.
// • `POST /auth/password/validate` (não consome) decide entre o formulário e "link inválido".
// • Já conectado (qualquer conta): avisa e só continua depois de "Sair" — o token não é consumido.
// • Sucesso: a API (22.1a) grava a senha, consome o link e ABRE a sessão ⇒ entra no painel.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';

import {
  LINK_INVALID,
  PASSWORD_CREATED,
  PASSWORDS_DIFFER,
  REQUEST_FAILED,
  TOO_MANY_ATTEMPTS,
  errorCode,
  errorStatus,
} from './auth-messages';
import { AuthScreen } from './AuthScreen';
import { AuthAlert, AuthPasswordField } from './fields';
import { localPasswordError, weakPasswordMessage } from './password-policy';

import { ApiError, apiClient } from '@/lib/api-client';
import { FORGOT_PATH, LOGIN_PATH } from '@/lib/public-routes';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type Phase = 'checking' | 'signed-in' | 'invalid' | 'form' | 'done';

interface MeResponse {
  authenticated?: boolean;
  user?: { name?: string | null; email?: string } | null;
}

/** Lê o token e o remove da URL (mantém só o caminho). Chamado uma única vez. */
export function takeTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (window.location.search || window.location.hash) {
    window.history.replaceState(window.history.state, '', window.location.pathname);
  }
  return token && token.length <= 200 ? token : null;
}

export function SetPasswordScreen(): JSX.Element {
  const router = useRouter();
  const tokenRef = useRef<string | null>(null);
  const readRef = useRef(false);
  const inFlight = useRef(false);
  const [phase, setPhase] = useState<Phase>('checking');
  const [signedInAs, setSignedInAs] = useState<string>('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // 1º render: tira o token da URL antes de qualquer outra coisa (inclusive das requisições).
  useIsomorphicLayoutEffect(() => {
    if (readRef.current) return;
    readRef.current = true;
    tokenRef.current = takeTokenFromUrl();
  }, []);

  const validateToken = useRef(async (): Promise<void> => {
    const token = tokenRef.current;
    if (!token) {
      setPhase('invalid');
      return;
    }
    try {
      const res = await apiClient.post<{ valid?: boolean }>('/auth/password/validate', { token });
      setPhase(res?.valid === true ? 'form' : 'invalid');
    } catch (err) {
      // Sem confirmação do link não há formulário; o motivo técnico só muda o texto (nunca a conta).
      const status = errorStatus(err);
      if (status === 429) setError(TOO_MANY_ATTEMPTS);
      else if (status === null || status >= 500) setError(REQUEST_FAILED);
      setPhase('invalid');
    }
  });

  useEffect(() => {
    let alive = true;
    void (async () => {
      // Sessão aberta (de qualquer conta) ⇒ não mexe no link até sair.
      try {
        const me = await apiClient.get<MeResponse>('/auth/me');
        if (alive && me?.authenticated === true) {
          setSignedInAs(me.user?.name?.trim() || me.user?.email || 'outra conta');
          setPhase('signed-in');
          return;
        }
      } catch {
        // 401 = sem sessão (o caso normal) — segue para o link.
      }
      if (alive) await validateToken.current();
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function logoutAndContinue(): Promise<void> {
    setLoggingOut(true);
    try {
      await apiClient.post('/auth/logout');
    } catch {
      // sem sessão já é o estado desejado
    }
    setLoggingOut(false);
    setPhase('checking');
    await validateToken.current();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    setError(null);
    const localError = localPasswordError(password);
    setFieldError(localError);
    const differ = confirm !== password ? PASSWORDS_DIFFER : null;
    setConfirmError(differ);
    if (localError || differ) return;
    const token = tokenRef.current;
    if (!token) {
      setPhase('invalid');
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      await apiClient.post('/auth/password/set', { token, password });
      tokenRef.current = null;
      setPassword('');
      setConfirm('');
      setPhase('done');
      router.replace('/');
      router.refresh();
    } catch (err) {
      const code = errorCode(err);
      if (code === 'invalid_or_expired_link') {
        tokenRef.current = null;
        setPhase('invalid');
      } else if (code === 'weak_password') {
        setFieldError(weakPasswordMessage(err instanceof ApiError ? err.body : null));
      } else if (errorStatus(err) === 429) {
        setError(TOO_MANY_ATTEMPTS);
      } else {
        setError(REQUEST_FAILED);
      }
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  if (phase === 'signed-in') {
    return (
      <AuthScreen title="Criar senha" subtitle="Você já está conectado">
        <div className="ds-auth-form">
          <AuthAlert tone="warning" testId="set-password-signed-in">
            {`Você já está conectado como ${signedInAs}. Saia para criar a senha de outra conta.`}
          </AuthAlert>
          <button type="button" className="ds-auth-button" onClick={() => void logoutAndContinue()} disabled={loggingOut}>
            {loggingOut ? 'Saindo…' : 'Sair e continuar'}
          </button>
          <Link href="/" className="ds-auth-button ds-auth-button--secondary">
            Voltar para o painel
          </Link>
        </div>
      </AuthScreen>
    );
  }

  if (phase === 'invalid') {
    return (
      <AuthScreen title="Link inválido" subtitle="Criar senha">
        <div className="ds-auth-form">
          <AuthAlert tone="critical" testId="set-password-invalid">
            {error ?? LINK_INVALID}
          </AuthAlert>
          <Link href={FORGOT_PATH} className="ds-auth-button">
            Pedir novo link
          </Link>
          <p className="ds-auth-switch">
            <Link href={LOGIN_PATH} className="ds-auth-link">
              Voltar para Entrar
            </Link>
          </p>
        </div>
      </AuthScreen>
    );
  }

  if (phase === 'checking') {
    return (
      <AuthScreen title="Criar senha" subtitle="Conferindo o link…">
        <p className="ds-auth-card__text" role="status">
          Conferindo o link…
        </p>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen title="Criar senha" subtitle="Escolha a senha que você vai usar para entrar">
      <form className="ds-auth-form" onSubmit={(e) => void handleSubmit(e)} noValidate aria-label="Criar senha">
        {phase === 'done' ? (
          <AuthAlert tone="success" testId="set-password-done">
            {PASSWORD_CREATED}
          </AuthAlert>
        ) : null}
        {error ? (
          <AuthAlert tone="critical" focusOnShow testId="set-password-error">
            {error}
          </AuthAlert>
        ) : null}
        <AuthPasswordField
          label="Nova senha"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          disabled={submitting || phase === 'done'}
          error={fieldError}
          checklist={{}}
          autoFocus
        />
        <AuthPasswordField
          label="Repita a senha"
          name="confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          disabled={submitting || phase === 'done'}
          error={confirmError}
        />
        <button type="submit" className="ds-auth-button" disabled={submitting || phase === 'done' || password.length === 0 || confirm.length === 0}>
          {submitting ? 'Criando…' : 'Criar senha'}
        </button>
      </form>
    </AuthScreen>
  );
}

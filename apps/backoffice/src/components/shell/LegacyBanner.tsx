'use client';

// @ds-migrated — Story 22.1b (AC9, T8): faixa persistente quando a sessão veio do acesso de
// emergência (`GET /auth/me → legacy: true`). O botão pede o link de criar senha para o e-mail do
// owner (`POST /auth/forgot`) e confirma com a frase fixa (Decisão 3). Sem `legacy`, nada aparece.

import { useState } from 'react';

import { useCurrentUser } from './current-user';

import { FORGOT_RECEIVED, REQUEST_FAILED, TOO_MANY_ATTEMPTS, errorStatus } from '@/components/auth/auth-messages';
import { apiClient } from '@/lib/api-client';

export const LEGACY_BANNER_TEXT =
  'Você entrou pelo acesso de emergência (temporário). Crie a sua senha pessoal: ele será desligado em breve.';

export function LegacyBanner(): JSX.Element | null {
  const { legacy, user } = useCurrentUser();
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string>(REQUEST_FAILED);
  if (!legacy || !user) return null;

  async function sendLink(): Promise<void> {
    if (!user || state === 'sending') return;
    setState('sending');
    try {
      await apiClient.post('/auth/forgot', { email: user.email });
      setState('sent');
    } catch (err) {
      setError(errorStatus(err) === 429 ? TOO_MANY_ATTEMPTS : REQUEST_FAILED);
      setState('error');
    }
  }

  return (
    <div className="ds-shell-notice ds-shell-notice--warning" role="status" data-testid="shell-legacy-notice">
      <span>{state === 'sent' ? FORGOT_RECEIVED : state === 'error' ? `${LEGACY_BANNER_TEXT} ${error}` : LEGACY_BANNER_TEXT}</span>
      {state === 'sent' ? null : (
        <button type="button" className="ds-shell-button" onClick={() => void sendLink()} disabled={state === 'sending'}>
          {state === 'sending' ? 'Enviando…' : 'Enviar link para criar minha senha'}
        </button>
      )}
    </div>
  );
}

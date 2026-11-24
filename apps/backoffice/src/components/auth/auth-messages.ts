// Story 22.1b (Decisão 3, T3) — textos FIXOS das telas de acesso. A mesma frase para qualquer causa:
// a tela nunca diz se o e-mail existe, se a conta está pendente, recusada, desativada ou bloqueada.

import { ApiError } from '@/lib/api-client';

export const LOGIN_INVALID = 'E-mail ou senha incorretos.';
export const TOO_MANY_ATTEMPTS = 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
export const LOGIN_FAILED = 'Não foi possível entrar. Tente novamente.';
export const REQUEST_FAILED = 'Não foi possível concluir agora. Tente novamente.';
export const SIGNUP_RECEIVED =
  'Recebemos sua solicitação. Quando o acesso for aprovado, você receberá um e-mail com o link para criar sua senha.';
export const FORGOT_RECEIVED = 'Se existir uma conta com esse e-mail, enviamos um link para criar ou redefinir a senha.';
export const LINK_INVALID = 'Este link é inválido ou expirou. Peça um novo em “Esqueci minha senha”.';
export const PASSWORD_CREATED = 'Senha criada. Entrando no painel…';
export const PASSWORDS_DIFFER = 'As senhas não são iguais.';
export const CURRENT_PASSWORD_WRONG = 'A senha atual não confere.';
export const PASSWORD_CHANGED = 'Senha alterada. As outras sessões abertas com a sua conta foram encerradas.';
export const PASSWORD_CHANGED_CONCURRENTLY = 'A senha foi alterada em outra sessão. Recarregue a página e tente de novo.';
export const EMAIL_INVALID = 'Digite um e-mail válido.';
export const NAME_INVALID = 'Digite seu nome (de 2 a 120 caracteres).';
export const SIGNUP_INVALID = 'Confira o nome e o e-mail.';
export const EMERGENCY_NOTICE = 'Acesso de emergência temporário — use apenas se não conseguir entrar pelo e-mail.';

/** Mesmo formato que a API aceita (`EMAIL_SHAPE` da 22.1a): algo@algo.algo, sem espaço. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  const email = normalizeEmail(value);
  return email.length >= 3 && email.length <= 254 && EMAIL_SHAPE.test(email);
}

export function errorStatus(err: unknown): number | null {
  return err instanceof ApiError ? err.status : null;
}

export function errorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (body !== null && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') {
    return (body as { code: string }).code;
  }
  return null;
}

/** Login e emergência: QUALQUER 401 é a mesma frase. */
export function loginErrorMessage(err: unknown): string {
  const status = errorStatus(err);
  if (status === 401) return LOGIN_INVALID;
  if (status === 429) return TOO_MANY_ATTEMPTS;
  return LOGIN_FAILED;
}

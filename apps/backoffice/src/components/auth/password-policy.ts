// Story 22.1b (Decisão 10) — a política de senha da API (22.1a: 12–128 caracteres, sem a parte do
// e-mail antes do @, fora da lista de senhas comuns) espelhada na tela SÓ como dica. Quem decide é a
// API; a tela traduz as violações que ela devolve (`weak_password`).

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
/** Parte local menor que isto não é checada (igual à API). */
const EMAIL_LOCAL_MIN = 3;

export type PasswordViolation = 'too_short' | 'too_long' | 'contains_email' | 'common';

export interface PasswordCheck {
  id: 'length' | 'email';
  label: string;
  ok: boolean;
}

function charLength(value: string): number {
  return [...value].length;
}

/** Itens da lista de conferência (o de e-mail só aparece quando a tela conhece o e-mail). */
export function passwordChecks(password: string, email?: string | null): PasswordCheck[] {
  const length = charLength(password);
  const checks: PasswordCheck[] = [
    { id: 'length', label: `${PASSWORD_MIN} caracteres ou mais`, ok: length >= PASSWORD_MIN && length <= PASSWORD_MAX },
  ];
  const local = (email ?? '').split('@')[0]?.trim().toLowerCase() ?? '';
  if (local.length >= EMAIL_LOCAL_MIN) {
    checks.push({ id: 'email', label: 'Não contém seu e-mail', ok: password.length > 0 && !password.toLowerCase().includes(local) });
  }
  return checks;
}

/** Erro local antes de enviar (só comprimento — o resto a API confere). */
export function localPasswordError(password: string): string | null {
  const length = charLength(password);
  if (length < PASSWORD_MIN) return `A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`;
  if (length > PASSWORD_MAX) return `A senha pode ter no máximo ${PASSWORD_MAX} caracteres.`;
  return null;
}

const VIOLATION_TEXT: Record<PasswordViolation, string> = {
  too_short: `A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`,
  too_long: `A senha pode ter no máximo ${PASSWORD_MAX} caracteres.`,
  contains_email: 'A senha não pode conter a parte do seu e-mail antes do @.',
  common: 'Essa senha é muito comum. Escolha outra.',
};

export function weakPasswordMessage(body: unknown): string {
  const raw = body !== null && typeof body === 'object' ? (body as { violations?: unknown }).violations : null;
  const list = Array.isArray(raw) ? raw.filter((v): v is PasswordViolation => typeof v === 'string' && v in VIOLATION_TEXT) : [];
  if (list.length === 0) return 'Escolha uma senha mais forte.';
  return list.map((v) => VIOLATION_TEXT[v]).join(' ');
}

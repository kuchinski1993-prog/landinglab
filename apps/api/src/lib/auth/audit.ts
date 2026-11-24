// Story 22.1a-1 · D14/A9 — trilha de auditoria de contas (auth_audit_log, append-only no banco).
//
// Tudo que entra passa por aqui: e-mail MASCARADO, IP e user-agent truncados (≤ 200) e o detalhe
// higienizado — chaves com cara de segredo saem inteiras e valores com cara de segredo (hash
// argon2/bcrypt, token base64url de 43, sha256 hex, `Bearer …`, link com `token=`, cookie) viram
// `[redacted]`. Nunca grava senha, hash, token, link, Cookie, Authorization nem corpo bruto.
import type { AuthRepo } from './users.repo.js';

export const AUTH_AUDIT_EVENTS = [
  'login_success',
  'login_failed',
  'login_locked',
  'legacy_login',
  'signup_requested',
  'signup_ignored',
  'owner_notify_failed',
  'invite_sent',
  'invite_failed',
  'reset_requested',
  'reset_sent',
  'reset_failed',
  'reset_used',
  'password_set',
  'password_changed',
  'user_approved',
  'user_rejected',
  'user_disabled',
  'user_enabled',
  'sessions_revoked',
  // 22.1a-2
  'mail_cooldown',
  'logout',
] as const;
export type AuthAuditEvent = (typeof AUTH_AUDIT_EVENTS)[number];

export const AUDIT_TEXT_MAX = 200;
const REDACTED = '[redacted]';
const MAX_DEPTH = 4;
const MAX_ITEMS = 20;
const MAX_STRING = 500;

/** `kuchinski1993@gmail.com` → `ku***@gmail.com`; sem formato de e-mail → `***`. */
export function maskEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}***@${domain}`.slice(0, 254);
}

export function truncateText(value: string | null | undefined, max = AUDIT_TEXT_MAX): string | null {
  if (value === null || value === undefined) return null;
  const chars = [...String(value)];
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

const SECRET_KEY = /pass(word)?|pwd|hash|token|secret|cookie|authorization|auth_?header|api_?key|link|url|session|sid|body|raw/i;

const SECRET_VALUE: readonly RegExp[] = [
  /\$argon2(id|i|d)\$/i,
  /\$2[abxy]?\$\d{2}\$/,
  /\b[0-9a-f]{64}\b/i,
  /(^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43}([^A-Za-z0-9_-]|$)/,
  /\bbearer\s+\S+/i,
  /[?&]token=/i,
  /blackshop\.sid=/i,
  /\bre_[A-Za-z0-9]{8,}/,
];

function looksSecret(value: string): boolean {
  return SECRET_VALUE.some((re) => re.test(value));
}

/** Cópia do detalhe sem segredos (chave suspeita sai; valor suspeito vira `[redacted]`). */
export function sanitizeAuditDetail(detail: unknown, depth = 0): unknown {
  if (detail === null || detail === undefined) return null;
  if (typeof detail === 'string') {
    if (looksSecret(detail)) return REDACTED;
    return detail.length > MAX_STRING ? `${detail.slice(0, MAX_STRING)}…` : detail;
  }
  if (typeof detail === 'number' || typeof detail === 'boolean') return detail;
  if (detail instanceof Date) return detail.toISOString();
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(detail)) return detail.slice(0, MAX_ITEMS).map((item) => sanitizeAuditDetail(item, depth + 1));
  if (typeof detail === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(detail as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = sanitizeAuditDetail(value, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

export interface AuthAuditInput {
  event: AuthAuditEvent;
  actorUserId?: string | null;
  subjectUserId?: string | null;
  /** E-mail em claro: só a versão mascarada é gravada. */
  email?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
  at?: Date;
}

/** Grava um evento (higienizado). Erro de gravação sobe para o chamador decidir. */
export async function recordAuthEvent(repo: AuthRepo, input: AuthAuditInput): Promise<void> {
  const detail = sanitizeAuditDetail(input.detail ?? {});
  await repo.appendAudit({
    event: input.event,
    actorUserId: input.actorUserId ?? null,
    subjectUserId: input.subjectUserId ?? null,
    emailMasked: maskEmail(input.email),
    ip: truncateText(input.ip),
    userAgent: truncateText(input.userAgent),
    detail: (detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {}) as Record<string, unknown>,
    ...(input.at ? { at: input.at } : {}),
  });
}

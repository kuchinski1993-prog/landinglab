// Story 22.1a-2 · envio dos e-mails de conta com a regra única de token + cadência + auditoria.
//
// A MESMA função serve "esqueci a senha", aprovar/reenviar convite (owner) e o script do operador
// (`auth:send-owner-invite`) — D9. O token em claro só existe aqui dentro, entre gerar e entregar ao
// mailer; nunca volta ao chamador, nunca vai para log nem auditoria (A3/A9).
import type { AppConfig } from '../../config.js';

import { recordAuthEvent, type AuthAuditEvent } from './audit.js';
import type { AuthMailer, AuthMailResult } from './mailer.js';
import { issueAuthToken } from './tokens.js';
import type { AuthRepo, AuthUser, TokenPurpose } from './users.repo.js';

/** No máximo 1 e-mail de link por conta a cada 2 min (AC11/AC15/AC21). */
export const MAIL_COOLDOWN_MS = 2 * 60_000;

export type MailOutcome = 'sent' | 'failed' | 'not_configured' | 'cooldown';

export interface AccountMailDeps {
  repo: AuthRepo;
  mailer: AuthMailer;
  config: Pick<AppConfig, 'authInviteTtlHours' | 'authResetTtlMinutes'>;
  log: { error: (obj: object, msg: string) => void };
}

export interface AuditContext {
  actorUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export function outcomeOf(result: AuthMailResult): Exclude<MailOutcome, 'cooldown'> {
  return result.status;
}

/** Detalhe seguro do resultado (sem token, link, chave). */
function mailDetail(result: AuthMailResult): Record<string, unknown> {
  if (result.status === 'sent') return { result: 'sent' };
  if (result.status === 'failed') return { result: 'failed', reason: result.reason, httpStatus: result.httpStatus };
  return { result: 'not_configured', missing: result.missing };
}

export function logMailNotConfigured(log: AccountMailDeps['log'], result: AuthMailResult, what: string): void {
  if (result.status !== 'not_configured') return;
  log.error(
    { missing: result.missing },
    `E-mail de acesso NÃO enviado (${what}): configuração ausente — ${result.missing
      .map((m) => (m === 'from' ? 'AUTH_EMAIL_FROM' : m === 'backoffice_url' ? 'BACKOFFICE_URL (https)' : 'chave resend:api_key no cofre'))
      .join(', ')}.`,
  );
}

function ttlMsFor(purpose: TokenPurpose, config: AccountMailDeps['config']): number | null {
  if (purpose === 'invite') return config.authInviteTtlHours ? config.authInviteTtlHours * 3_600_000 : null;
  return config.authResetTtlMinutes ? config.authResetTtlMinutes * 60_000 : null;
}

/** Finalidade do link conforme o estado: `active` ⇒ redefinição; aprovado sem senha ⇒ convite; outro ⇒ nenhum. */
export function linkPurposeFor(user: Pick<AuthUser, 'status'>): TokenPurpose | null {
  if (user.status === 'active') return 'reset';
  if (user.status === 'approved_pending_password') return 'invite';
  return null;
}

/**
 * Gera o link (invalida o anterior da mesma finalidade) e envia. Respeita a cadência de 2 min.
 * Conta fora de `active`/`approved_pending_password` ⇒ `null` (nada acontece).
 */
export async function sendPasswordLinkFor(
  deps: AccountMailDeps,
  user: AuthUser,
  now: Date,
  ctx: AuditContext = {},
): Promise<{ purpose: TokenPurpose; mail: MailOutcome } | null> {
  const purpose = linkPurposeFor(user);
  if (!purpose) return null;
  const sentEvent: AuthAuditEvent = purpose === 'invite' ? 'invite_sent' : 'reset_sent';
  const failedEvent: AuthAuditEvent = purpose === 'invite' ? 'invite_failed' : 'reset_failed';

  const last = await deps.repo.lastTokenIssuedAt(user.id);
  if (last && now.getTime() - last.getTime() < MAIL_COOLDOWN_MS) {
    await recordAuthEvent(deps.repo, {
      event: 'mail_cooldown',
      actorUserId: ctx.actorUserId ?? null,
      subjectUserId: user.id,
      email: user.email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detail: { result: 'cooldown' },
      at: now,
    });
    return { purpose, mail: 'cooldown' };
  }

  const { token } = await issueAuthToken(deps.repo, {
    userId: user.id,
    purpose,
    now,
    createdBy: ctx.actorUserId ?? null,
    ttlMs: ttlMsFor(purpose, deps.config),
  });
  let result: AuthMailResult;
  try {
    result = await deps.mailer.sendPasswordLink({ to: user.email, kind: purpose, token, name: user.name });
  } catch {
    result = { status: 'failed', reason: 'network', httpStatus: null };
  }
  logMailNotConfigured(deps.log, result, purpose === 'invite' ? 'convite' : 'redefinição');
  await recordAuthEvent(deps.repo, {
    event: result.status === 'sent' ? sentEvent : failedEvent,
    actorUserId: ctx.actorUserId ?? null,
    subjectUserId: user.id,
    email: user.email,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    detail: mailDetail(result),
    at: now,
  });
  return { purpose, mail: outcomeOf(result) };
}

/** D12 — avisa TODOS os owners ativos (best-effort). Falha ⇒ `owner_notify_failed`; a solicitação fica salva. */
export async function notifyOwnersOfSignup(
  deps: AccountMailDeps,
  requester: { id: string | null; name: string; email: string },
  now: Date,
): Promise<{ sent: number; failed: number }> {
  const owners = (await deps.repo.listOwners()).filter((o) => o.status === 'active' || o.status === 'approved_pending_password');
  let sent = 0;
  let failed = 0;
  for (const owner of owners) {
    let result: AuthMailResult;
    try {
      result = await deps.mailer.sendSignupNotice({ to: owner.email, requesterName: requester.name, requesterEmail: requester.email });
    } catch {
      result = { status: 'failed', reason: 'network', httpStatus: null };
    }
    if (result.status === 'sent') {
      sent++;
      continue;
    }
    failed++;
    logMailNotConfigured(deps.log, result, 'aviso de nova solicitação');
    await recordAuthEvent(deps.repo, {
      event: 'owner_notify_failed',
      subjectUserId: requester.id,
      email: requester.email,
      detail: { ...mailDetail(result), owner: owner.id },
      at: now,
    });
  }
  if (owners.length === 0) {
    failed++;
    await recordAuthEvent(deps.repo, {
      event: 'owner_notify_failed',
      subjectUserId: requester.id,
      email: requester.email,
      detail: { result: 'no_owner' },
      at: now,
    });
  }
  return { sent, failed };
}

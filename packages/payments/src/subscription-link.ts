// Link assinado de gestão da assinatura (Story 15.6, AC11 / decisão O5).
//
// Token = base64url(payload JSON) "." base64url(HMAC-SHA256). Payload:
//   { v: 1, s: <landing_subscriptions.id>, e: <hash do e-mail>, x: <expira, unix s> }
// Gerado só no servidor; validado com comparação timing-safe. O e-mail não vai
// em claro no token (só um hash curto que a API compara com o da assinatura).
//
// Chave: env LANDINGLAB_SUBSCRIPTION_LINK_SECRET (>= 32 chars) ou, na falta,
// derivada do VAULT_SECRET (HMAC com rótulo fixo). Sem nenhuma → links
// desativados (null), nunca uma chave fraca.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const MANAGE_LINK_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

export interface ManageTokenPayload {
  subscriptionId: string;
  emailHash: string;
  expiresAt: Date;
}

export function manageLinkSecret(env: NodeJS.ProcessEnv = process.env, vaultSecret?: string | null): string | null {
  const own = env['LANDINGLAB_SUBSCRIPTION_LINK_SECRET']?.trim();
  if (own && own.length >= MIN_SECRET_LENGTH) return own;
  const vault = (vaultSecret ?? env['VAULT_SECRET'] ?? '').trim();
  if (vault.length >= MIN_SECRET_LENGTH) {
    return createHmac('sha256', vault).update('landinglab-subscription-manage-link-v1').digest('hex');
  }
  return null;
}

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('base64url').slice(0, 22);
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signManageToken(
  secret: string,
  input: { subscriptionId: string; email: string },
  now: Date = new Date(),
  ttlSeconds: number = MANAGE_LINK_TTL_SECONDS,
): string {
  const payload = {
    v: 1,
    s: input.subscriptionId,
    e: emailHash(input.email),
    x: Math.floor(now.getTime() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** null para qualquer token inválido, adulterado ou expirado (sem distinção). */
export function verifyManageToken(secret: string, token: unknown, now: Date = new Date()): ManageTokenPayload | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const p = payload as { v?: unknown; s?: unknown; e?: unknown; x?: unknown };
  if (p.v !== 1 || typeof p.s !== 'string' || typeof p.e !== 'string' || typeof p.x !== 'number') return null;
  if (p.x * 1000 <= now.getTime()) return null;
  return { subscriptionId: p.s, emailHash: p.e, expiresAt: new Date(p.x * 1000) };
}

/** Caminho relativo da página de gestão no domínio da landing. */
export function manageLinkPath(token: string): string {
  return `/assinatura/gerir?t=${encodeURIComponent(token)}`;
}

/** URL absoluta (e-mails). null se o host não for um hostname simples. */
export function manageLinkUrl(host: string | null | undefined, token: string): string | null {
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) return null;
  return `https://${host}${manageLinkPath(token)}`;
}

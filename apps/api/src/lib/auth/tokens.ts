// Story 22.1a-1 · AC7 — tokens de convite/redefinição de senha (D3).
//
// - 32 bytes de crypto.randomBytes em base64url (43 caracteres) → só volta ao chamador para montar
//   o link do e-mail; no banco vai SÓ o sha256 em hex (A3).
// - Consumo de uso único é atômico no repositório (UPDATE condicional) — dois cliques: um vence (A4).
// - Expirado, usado, de finalidade errada, de outro usuário ou malformado ⇒ o MESMO `invalid`
//   (sem oráculo de motivo).
// - TTL: convite 48 h, redefinição 60 min; configuráveis, mas sempre dentro de piso e teto.
import { createHash, randomBytes } from 'node:crypto';

import type { AuthRepo, TokenPurpose } from './users.repo.js';

export const TOKEN_BYTES = 32;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const TOKEN_TTL_MS: Readonly<Record<TokenPurpose, { default: number; min: number; max: number }>> = {
  invite: { default: 48 * HOUR, min: 15 * MINUTE, max: 7 * 24 * HOUR },
  reset: { default: 60 * MINUTE, min: 5 * MINUTE, max: 24 * HOUR },
};

export type TokenCheck = { status: 'valid'; userId: string } | { status: 'invalid' };

const INVALID: TokenCheck = Object.freeze({ status: 'invalid' });

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** TTL efetivo: `override` (ms) preso entre piso e teto da finalidade; inválido ⇒ padrão. */
export function resolveTokenTtlMs(purpose: TokenPurpose, overrideMs?: number | null): number {
  const limits = TOKEN_TTL_MS[purpose];
  if (overrideMs === undefined || overrideMs === null || !Number.isFinite(overrideMs) || overrideMs <= 0) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, Math.floor(overrideMs)));
}

/**
 * Emite um token novo (invalida os abertos do mesmo usuário/finalidade). O token em claro só
 * existe no retorno — quem chama monta o link e o descarta; nunca logar.
 */
export async function issueAuthToken(
  repo: AuthRepo,
  input: { userId: string; purpose: TokenPurpose; now: Date; createdBy?: string | null; ttlMs?: number | null },
): Promise<{ token: string; expiresAt: Date }> {
  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(input.now.getTime() + resolveTokenTtlMs(input.purpose, input.ttlMs));
  await repo.issueToken({ userId: input.userId, purpose: input.purpose, tokenHash, expiresAt, createdBy: input.createdBy ?? null, now: input.now });
  return { token, expiresAt };
}

function wellFormed(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_FORMAT.test(token);
}

/** Não consome (tela "criar senha" checa o link antes de pedir a senha). */
export async function checkAuthToken(
  repo: AuthRepo,
  input: { token: unknown; purpose: TokenPurpose; now: Date; userId?: string },
): Promise<TokenCheck> {
  if (!wellFormed(input.token)) return INVALID;
  const row = await repo.peekToken({ tokenHash: hashToken(input.token), purpose: input.purpose, now: input.now, userId: input.userId });
  return row ? { status: 'valid', userId: row.userId } : INVALID;
}

/** Consumo de uso único. */
export async function consumeAuthToken(
  repo: AuthRepo,
  input: { token: unknown; purpose: TokenPurpose; now: Date; userId?: string },
): Promise<TokenCheck> {
  if (!wellFormed(input.token)) return INVALID;
  const row = await repo.consumeToken({ tokenHash: hashToken(input.token), purpose: input.purpose, now: input.now, userId: input.userId });
  return row ? { status: 'valid', userId: row.userId } : INVALID;
}

/**
 * Consome o token e grava a senha (já em hash) numa transação só: ativa a conta, invalida todos os
 * tokens abertos e revoga todas as sessões do usuário.
 */
export async function redeemAuthToken(
  repo: AuthRepo,
  input: { token: unknown; purpose: TokenPurpose; now: Date; passwordHash: string },
): Promise<TokenCheck> {
  if (!wellFormed(input.token)) return INVALID;
  const res = await repo.redeemTokenAndSetPassword({
    tokenHash: hashToken(input.token),
    purpose: input.purpose,
    now: input.now,
    passwordHash: input.passwordHash,
  });
  return res.ok ? { status: 'valid', userId: res.userId } : INVALID;
}

// Story 22.1a-1 · AC8 — bloqueio progressivo POR CONTA (D6, A2/A11).
//
// - 1ª–4ª falha na janela: sem bloqueio. A partir da 5ª: locked_until = agora + min(15 min,
//   30 s × 2^(falhas − 5)) → 5ª = 30 s, 6ª = 60 s, 7ª = 2 min … teto 15 min.
// - Janela: a contagem continua enquanto a falha anterior (ou o fim do bloqueio) tiver < 15 min;
//   depois disso recomeça do 1.
// - Tentativa DURANTE o bloqueio não conta nem estende o bloqueio (um terceiro não consegue
//   empurrar a trava do dono para sempre) — e a senha AINDA é verificada (mesmo custo de tempo),
//   mas o resultado é a MESMA falha de senha errada (A1).
// - Sucesso zera tudo. O bloqueio só impede tentar senha: "esqueci a senha" e o link de convite
//   não passam por aqui (o dono nunca fica sem caminho — A8).
// Relógio sempre injetado (`now`) — testes sem esperar.
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';
import type { AuthRepo, AuthUser, ThrottleState } from './users.repo.js';

export const THROTTLE_POLICY = {
  freeFailures: 4,
  windowMs: 15 * 60_000,
  baseLockMs: 30_000,
  maxLockMs: 15 * 60_000,
} as const;

export function isLocked(state: Pick<ThrottleState, 'lockedUntil'>, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/** Duração do bloqueio depois de `failures` falhas na janela (0 = sem bloqueio). */
export function lockDurationMs(failures: number): number {
  if (failures <= THROTTLE_POLICY.freeFailures) return 0;
  const exp = failures - (THROTTLE_POLICY.freeFailures + 1);
  // 2^exp cresce rápido; acima de 2^10 já passou do teto.
  return Math.min(THROTTLE_POLICY.maxLockMs, THROTTLE_POLICY.baseLockMs * 2 ** Math.min(exp, 10));
}

/** Estado depois de uma senha errada. Durante o bloqueio devolve o estado sem mudança. */
export function nextFailureState(prev: ThrottleState, now: Date): ThrottleState {
  if (isLocked(prev, now)) return prev;
  const anchor = Math.max(prev.lastFailedLoginAt?.getTime() ?? -Infinity, prev.lockedUntil?.getTime() ?? -Infinity);
  const inWindow = Number.isFinite(anchor) && now.getTime() - anchor < THROTTLE_POLICY.windowMs;
  const failedLoginCount = inWindow ? prev.failedLoginCount + 1 : 1;
  const lockMs = lockDurationMs(failedLoginCount);
  return {
    failedLoginCount,
    lastFailedLoginAt: now,
    lockedUntil: lockMs > 0 ? new Date(now.getTime() + lockMs) : null,
  };
}

export const CLEAR_THROTTLE: ThrottleState = Object.freeze({ failedLoginCount: 0, lastFailedLoginAt: null, lockedUntil: null });

/** Motivo interno (só auditoria; a resposta pública é sempre a mesma). */
export type LoginFailureReason = 'unknown_email' | 'not_active' | 'no_password' | 'locked' | 'wrong_password';

export type LoginAttemptResult =
  | { ok: true; user: AuthUser; rehashed: boolean }
  | { ok: false; reason: LoginFailureReason; lockedNow: boolean };

/**
 * Uma tentativa de senha para uma conta (já buscada pelo e-mail; `null` = inexistente).
 * A verificação argon2 roda SEMPRE (inexistente, sem senha e bloqueado inclusive). Só conta
 * `active` com senha certa e sem bloqueio entra; sucesso zera falhas e regrava o hash se os
 * parâmetros mudaram (needsRehash).
 */
export async function attemptPasswordLogin(
  repo: AuthRepo,
  user: AuthUser | null,
  password: string,
  now: Date,
): Promise<LoginAttemptResult> {
  const locked = user ? isLocked(user, now) : false;
  const valid = await verifyPassword(user?.passwordHash ?? null, password);

  if (!user) return { ok: false, reason: 'unknown_email', lockedNow: false };
  if (locked) return { ok: false, reason: 'locked', lockedNow: true };

  if (valid && user.status === 'active') {
    await repo.recordLoginSuccess(user.id, now);
    let rehashed = false;
    if (user.passwordHash && needsRehash(user.passwordHash)) {
      // Compare-and-swap: se a senha foi redefinida enquanto este login verificava, não regrava
      // o hash da senha antiga por cima da nova.
      rehashed = await repo.updatePasswordHash(user.id, await hashPassword(password), now, user.passwordHash);
    }
    return { ok: true, user, rehashed };
  }

  const state = await repo.updateThrottle(user.id, (prev) => nextFailureState(prev, now));
  const lockedNow = state ? isLocked(state, now) : false;
  if (!user.passwordHash) return { ok: false, reason: 'no_password', lockedNow };
  if (user.status !== 'active') return { ok: false, reason: 'not_active', lockedNow };
  return { ok: false, reason: 'wrong_password', lockedNow };
}

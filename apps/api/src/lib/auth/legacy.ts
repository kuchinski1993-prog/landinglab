// Story 22.1a-2 · D10/AC19 (A8/A12) — acesso de emergência com a senha antiga (APP_PASSWORD_HASH).
//
// Vale SÓ enquanto: LEGACY_LOGIN_ENABLED ≠ false E agora < LEGACY_LOGIN_UNTIL. Fora de produção
// (dev/test) a data é opcional; em produção sem data a emergência fica DESLIGADA (fail-closed) e o
// boot avisa alto (C-3). A sessão criada é do usuário owner (nunca anônima), `via: 'legacy'`.
// Removido por inteiro na 22.1d.
import bcrypt from 'bcrypt';

import type { AppConfig } from '../../config.js';

export type LegacyLoginState =
  | { enabled: true; until: Date | null }
  | { enabled: false; reason: 'disabled' | 'missing_until' | 'expired' | 'missing_hash' };

type LegacyConfig = Pick<AppConfig, 'nodeEnv' | 'legacyLoginEnabled' | 'legacyLoginUntil' | 'appPasswordHash'>;

export function legacyLoginState(config: LegacyConfig, now: Date): LegacyLoginState {
  if (!config.legacyLoginEnabled) return { enabled: false, reason: 'disabled' };
  if (!config.appPasswordHash || !config.appPasswordHash.startsWith('$2')) return { enabled: false, reason: 'missing_hash' };
  const until = config.legacyLoginUntil;
  if (!until) return config.nodeEnv === 'production' ? { enabled: false, reason: 'missing_until' } : { enabled: true, until: null };
  if (now.getTime() >= until.getTime()) return { enabled: false, reason: 'expired' };
  return { enabled: true, until };
}

/** Compara com o bcrypt legado. Com a emergência desligada, NÃO compara (nada a proteger em tempo: sem e-mail). */
export async function verifyLegacyPassword(config: LegacyConfig, password: string, now: Date): Promise<boolean> {
  if (!legacyLoginState(config, now).enabled) return false;
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return false;
  try {
    return await bcrypt.compare(password, config.appPasswordHash);
  } catch {
    return false;
  }
}

/** C-3 — aviso no boot sobre o estado da emergência (warn quando desligada em produção). */
export function reportLegacyLoginState(
  config: LegacyConfig,
  log: { warn: (msg: string) => void; info: (msg: string) => void },
  now: Date = new Date(),
): LegacyLoginState {
  const state = legacyLoginState(config, now);
  if (config.nodeEnv === 'test') return state;
  if (state.enabled) {
    log.warn(
      `Acesso de emergência (senha antiga APP_PASSWORD_HASH) LIGADO até ${state.until ? state.until.toISOString() : 'sem data (fora de produção)'}: ` +
        'POST /auth/login sem e-mail e POST /auth/login/emergency. Remover na 22.1d.',
    );
  } else if (config.nodeEnv === 'production' && state.reason !== 'disabled') {
    const why =
      state.reason === 'missing_until'
        ? 'LEGACY_LOGIN_UNTIL ausente ou inválida'
        : state.reason === 'expired'
          ? 'LEGACY_LOGIN_UNTIL já passou'
          : 'APP_PASSWORD_HASH inválido';
    log.warn(
      `ATENÇÃO: acesso de emergência DESLIGADO (${why}). O painel antigo (POST /auth/login { password }) NÃO entra. ` +
        'Se o login novo ainda não foi confirmado pelo owner, defina LEGACY_LOGIN_UNTIL (ISO 8601, ex.: deploy + 14 dias) e reinicie a API.',
    );
  } else {
    log.info('Acesso de emergência (senha antiga) desligado por LEGACY_LOGIN_ENABLED=false.');
  }
  return state;
}

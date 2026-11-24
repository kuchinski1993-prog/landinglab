// Story 22.1a-1 · AC6 — senhas: hash argon2id, verificação, rehash e política (D1/D8).
//
// argon2id via @node-rs/argon2 (binário pré-compilado — glibc e musl —, sem node-gyp), versão
// FIXADA no package.json. Parâmetros OWASP: m = 19456 KiB, t = 2, p = 1. O algoritmo fica isolado
// aqui: o plano B (bcrypt custo 12, R2) troca só este arquivo sem mudar o contrato.
// bcrypt continua SÓ para a senha de emergência legada (APP_PASSWORD_HASH, auth.plugin.ts).
//
// Nada deste módulo loga: nem senha, nem hash, nem motivo detalhado.
import { randomBytes } from 'node:crypto';

import { hash, parseOptions, verify, type Algorithm } from '@node-rs/argon2';

import { isCommonPassword } from './common-passwords.js';

// `Algorithm` é `const enum` ambiente (isolatedModules impede ler `Algorithm.Argon2id`): 2 = Argon2id.
const ARGON2ID = 2 as Algorithm;

export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
/** Parte local do e-mail menor que isto não é checada (evita recusar senhas por conter "a"). */
const EMAIL_LOCAL_MIN = 3;

export type PasswordPolicyViolation = 'too_short' | 'too_long' | 'contains_email' | 'common';

export type PasswordPolicyResult = { ok: true } | { ok: false; violations: PasswordPolicyViolation[] };

/** Comprimento em caracteres (code points), não em unidades UTF-16. */
function charLength(value: string): number {
  return [...value].length;
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) throw new Error('password_required');
  return hash(password, ARGON2_PARAMS);
}

let dummyHashPromise: Promise<string> | null = null;

/** Hash argon2id de uma senha aleatória descartada — alvo da verificação "de mentira". */
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hash(randomBytes(32).toString('base64url'), ARGON2_PARAMS);
  return dummyHashPromise;
}

function isArgon2Hash(stored: string): boolean {
  return stored.startsWith('$argon2id$');
}

/**
 * Verificação em tempo constante (o argon2 compara internamente sem atalho). Sem hash utilizável
 * (usuário inexistente, sem senha ou hash de outro formato) roda a verificação contra o hash de
 * mentira e devolve `false` — o custo é o mesmo nos dois ramos (A1).
 */
export async function verifyPassword(stored: string | null | undefined, password: string): Promise<boolean> {
  const candidate = typeof password === 'string' ? password : '';
  if (!stored || !isArgon2Hash(stored) || candidate.length === 0 || charLength(candidate) > PASSWORD_MAX_LENGTH) {
    await dummyVerify(candidate);
    return false;
  }
  try {
    return await verify(stored, candidate);
  } catch {
    return false;
  }
}

/** Mesmo custo de uma verificação real, resultado descartado (e-mail inexistente / conta bloqueada). */
export async function dummyVerify(password: string): Promise<void> {
  const target = await dummyHash();
  try {
    await verify(target, password.length > 0 ? password.slice(0, PASSWORD_MAX_LENGTH * 2) : 'x');
  } catch {
    // resultado descartado
  }
}

/** `true` quando o hash gravado não usa os parâmetros atuais (rehash no próximo login). */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored || !isArgon2Hash(stored)) return true;
  try {
    const o = parseOptions(stored);
    return (
      o.algorithm !== ARGON2_PARAMS.algorithm ||
      o.memoryCost !== ARGON2_PARAMS.memoryCost ||
      o.timeCost !== ARGON2_PARAMS.timeCost ||
      o.parallelism !== ARGON2_PARAMS.parallelism ||
      o.outputLen !== ARGON2_PARAMS.outputLen
    );
  } catch {
    return true;
  }
}

/** D8: 12–128 caracteres, sem a parte local do e-mail, fora da lista local de senhas comuns. */
export function validatePasswordPolicy(password: string, email?: string | null): PasswordPolicyResult {
  const violations: PasswordPolicyViolation[] = [];
  const value = typeof password === 'string' ? password : '';
  const len = charLength(value);
  if (len < PASSWORD_MIN_LENGTH) violations.push('too_short');
  if (len > PASSWORD_MAX_LENGTH) violations.push('too_long');
  const local = (email ?? '').trim().toLowerCase().split('@')[0] ?? '';
  if (local.length >= EMAIL_LOCAL_MIN && value.toLowerCase().includes(local)) violations.push('contains_email');
  if (isCommonPassword(value)) violations.push('common');
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

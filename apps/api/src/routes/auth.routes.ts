// Story 22.1a-2 · rotas de conta (AC9–14, AC19) — login e-mail+senha, cadastro como solicitação,
// esqueci a senha, validar/definir senha por link, logout, troca de senha, /auth/me com o usuário real
// e o acesso de emergência com a senha antiga (D10).
//
// Segurança (códigos A* da story):
//  - A1: falha de login é SEMPRE o mesmo 401; cadastro/esqueci SEMPRE o mesmo 202; piso de tempo; o
//    que depende de rede (e-mail) roda DEPOIS da resposta (o tempo não revela se a conta existe).
//  - A2/SEC-003: bloqueio por conta (throttle.ts) + rate limit por IP com chaves compostas
//    (lib/auth/rate-limit.ts); o link de redefinição usado ABRE sessão — o dono nunca fica trancado
//    por um terceiro que só conhece o e-mail dele.
//  - A5: `regenerate()` no login (sid novo; o anterior é apagado da loja); sessões revogadas na troca
//    de senha, desativação e definição por link.
//  - A6/C-1: Origin obrigatório em produção + só JSON nas rotas públicas (request-guard.ts).
//  - A9: nada aqui loga senha, token, link ou corpo; auditoria higienizada (audit.ts).
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { notifyOwnersOfSignup, sendPasswordLinkFor, type AccountMailDeps } from '../lib/auth/account-mail.js';
import { recordAuthEvent, truncateText } from '../lib/auth/audit.js';
import { legacyLoginState, verifyLegacyPassword } from '../lib/auth/legacy.js';
import { EMAIL_SHAPE } from '../lib/auth/mailer.js';
import {
  INVALID_CREDENTIALS,
  INVALID_OR_EXPIRED_LINK,
  PUBLIC_RESPONSE_FLOOR_MS,
  REQUEST_RECEIVED,
  withTimeFloor,
} from '../lib/auth/no-enumeration.js';
import { hashPassword, validatePasswordPolicy, verifyPassword } from '../lib/auth/passwords.js';
import { AUTH_RATE_LIMITS, authRateLimitKey, type AuthKeyKind, type AuthRateLimit, type AuthRateLimitName } from '../lib/auth/rate-limit.js';
import { accountRequestGuard } from '../lib/auth/request-guard.js';
import { hashSessionId, markFreshSession } from '../lib/auth/session-store.js';
import { attemptPasswordLogin, isLocked, nextFailureState } from '../lib/auth/throttle.js';
import { checkAuthToken, redeemAuthToken } from '../lib/auth/tokens.js';
import {
  PASSWORD_SETTABLE_STATUSES,
  USABLE_OWNER_STATUSES,
  normalizeEmail,
  type AuthUser,
  type TokenPurpose,
} from '../lib/auth/users.repo.js';
import { clientIpKeyGenerator } from '../lib/client-ip.js';

import '../types.js';

/** Teto de solicitações pendentes (AC10): acima disso o cadastro responde 202 sem criar. */
export const PENDING_SIGNUP_CAP = 50;

/** Corpo do 401 do login legado sem e-mail — CONGELADO pela caracterização (painel antigo, A12). */
const LEGACY_INVALID = Object.freeze({ error: 'Invalid credentials', statusCode: 401 });
const UNAUTHORIZED = Object.freeze({ error: 'Unauthorized', statusCode: 401 });

export interface AuthRoutesOptions {
  /** Piso de tempo das respostas públicas (padrão 300 ms; testes podem baixar). */
  floorMs?: number;
  /** Sobrescreve limites por rota (testes). */
  rateLimits?: Partial<Record<AuthRateLimitName, AuthRateLimit>>;
}

export function publicUser(user: Pick<AuthUser, 'id' | 'name' | 'email' | 'role'>): { id: string; name: string | null; email: string; role: string } {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export function requestContext(fastify: FastifyInstance, request: FastifyRequest): { ip: string | null; userAgent: string | null } {
  const ip = clientIpKeyGenerator(fastify.config.landinglabProxySecret)(request);
  const ua = request.headers['user-agent'];
  return { ip: truncateText(ip), userAgent: truncateText(typeof ua === 'string' ? ua : null) };
}

function promisify(fn: (cb: (err?: unknown) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => fn((err) => (err ? reject(err instanceof Error ? err : new Error('session_store_error')) : resolve())));
}

/** A5 — sessão nova (sid novo; o anterior sai da loja) para o usuário. */
export async function openUserSession(
  fastify: FastifyInstance,
  request: FastifyRequest,
  user: Pick<AuthUser, 'id' | 'role'>,
  via: 'password' | 'legacy',
): Promise<void> {
  const previousSid = request.session?.sessionId;
  await request.session.regenerate();
  if (previousSid && previousSid !== request.session.sessionId) {
    await promisify((cb) => request.sessionStore.destroy(previousSid, cb));
  }
  const ctx = requestContext(fastify, request);
  request.session.authenticated = true;
  request.session.userId = user.id;
  request.session.role = user.role;
  request.session.via = via;
  request.session.loginAt = new Date().toISOString();
  if (ctx.ip) request.session.clientIp = ctx.ip;
  if (ctx.userAgent) request.session.userAgent = ctx.userAgent;
  markFreshSession(request.session);
}

/** Usuário da sessão ainda pode usar o painel? (relido do banco em /auth/me) */
export function sessionUserValid(user: AuthUser | null, via: 'password' | 'legacy' | undefined): user is AuthUser {
  if (!user) return false;
  if (via === 'legacy') return user.role === 'owner' && USABLE_OWNER_STATUSES.includes(user.status);
  return user.status === 'active';
}

/** Owner usado pela emergência: o mais antigo utilizável (o semeado pela 0102). */
export function pickLegacyOwner(owners: AuthUser[]): AuthUser | null {
  return owners.find((o) => USABLE_OWNER_STATUSES.includes(o.status)) ?? null;
}

/** Troca caracteres de controle por espaço (a nota mantém quebras de linha). */
export function stripControl(value: string, keepNewlines: boolean): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f;
    out += control && !(keepNewlines && (ch === '\n' || ch === '\t')) ? ' ' : ch;
  }
  return out.trim();
}

/** Background (depois da resposta): erro vai ao log só com o tipo — nunca dados. */
function runInBackground(fastify: FastifyInstance, label: string, work: () => Promise<unknown>): void {
  setImmediate(() => {
    work().catch((err: unknown) => {
      fastify.log.error({ errName: err instanceof Error ? err.name : 'unknown', errCode: (err as { code?: unknown })?.code ?? null }, `auth: falha em ${label}`);
    });
  });
}

/** Link válido para qualquer finalidade (o mesmo `/criar-senha` serve convite e redefinição). */
async function findLinkPurpose(fastify: FastifyInstance, token: unknown, now: Date): Promise<{ purpose: TokenPurpose; userId: string } | null> {
  for (const purpose of ['reset', 'invite'] as const) {
    const check = await checkAuthToken(fastify.authRepo, { token, purpose, now });
    if (check.status === 'valid') return { purpose, userId: check.userId };
  }
  return null;
}

interface LoginBody {
  email?: string;
  password: string;
}

interface SignupBody {
  name: string;
  email: string;
  note?: string;
  website?: string;
}

const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (fastify, opts) => {
  const config = fastify.config;
  const repo = fastify.authRepo;
  const floorMs = opts.floorMs ?? PUBLIC_RESPONSE_FLOOR_MS;
  const mailDeps = (): AccountMailDeps => ({
    repo,
    mailer: fastify.authMailer,
    config,
    log: { error: (obj, msg) => fastify.log.error(obj, msg) },
  });

  const publicJson = accountRequestGuard(config, { json: true, origin: 'required' });
  const sessionJson = accountRequestGuard(config, { json: true, origin: 'allowed' });
  const sessionNoBody = accountRequestGuard(config, { json: false, origin: 'allowed' });

  function rateLimit(name: AuthRateLimitName, key: AuthKeyKind) {
    const limit = opts.rateLimits?.[name] ?? AUTH_RATE_LIMITS[name];
    return {
      rateLimit: {
        max: limit.max,
        timeWindow: limit.timeWindow,
        hook: 'preHandler' as const,
        keyGenerator: authRateLimitKey(key, config.landinglabProxySecret),
      },
    };
  }

  // ── Emergência (D10): senha antiga ⇒ sessão do owner, `via: 'legacy'` ──
  async function legacyLogin(request: FastifyRequest, password: string, mode: 'compat' | 'emergency'): Promise<AuthUser | null> {
    const now = new Date();
    const ctx = requestContext(fastify, request);
    return withTimeFloor(async () => {
      const state = legacyLoginState(config, now);
      if (!state.enabled) {
        await recordAuthEvent(repo, { event: 'login_failed', ...ctx, detail: { via: 'legacy', mode, reason: `legacy_${state.reason}` }, at: now });
        return null;
      }
      const owner = pickLegacyOwner(await repo.listOwners());
      if (!owner) {
        fastify.log.error('Acesso de emergência recusado: nenhum owner utilizável em `users` (migrations 0101–0102 aplicadas?).');
        await recordAuthEvent(repo, { event: 'login_failed', ...ctx, detail: { via: 'legacy', mode, reason: 'no_owner' }, at: now });
        return null;
      }
      const locked = isLocked(owner, now);
      const valid = await verifyLegacyPassword(config, password, now);
      if (locked || !valid) {
        if (!locked) await repo.updateThrottle(owner.id, (prev) => nextFailureState(prev, now));
        await recordAuthEvent(repo, {
          event: 'login_failed',
          subjectUserId: owner.id,
          ...ctx,
          detail: { via: 'legacy', mode, reason: locked ? 'locked' : 'wrong_password' },
          at: now,
        });
        return null;
      }
      await repo.recordLoginSuccess(owner.id, now);
      fastify.log.warn({ via: 'legacy', mode }, 'auth: acesso de emergência usado (senha antiga) — sessão do owner');
      await recordAuthEvent(repo, { event: 'legacy_login', actorUserId: owner.id, subjectUserId: owner.id, email: owner.email, ...ctx, detail: { level: 'warn', mode }, at: now });
      return owner;
    }, floorMs);
  }

  // ── POST /auth/login (AC9) — com `email`: conta; sem `email`: compatibilidade do painel antigo (A12) ──
  fastify.post<{ Body: LoginBody }>(
    '/auth/login',
    {
      onRequest: publicJson,
      config: rateLimit('login', 'ip+email'),
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          properties: {
            email: { type: 'string', maxLength: 320 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      if (email === undefined) {
        const owner = await legacyLogin(request, password, 'compat');
        if (!owner) return reply.code(401).send(LEGACY_INVALID);
        await openUserSession(fastify, request, owner, 'legacy');
        return reply.code(200).send({ status: 'ok' });
      }

      const now = new Date();
      const ctx = requestContext(fastify, request);
      const result = await withTimeFloor(async () => {
        const normalized = normalizeEmail(email);
        const user = EMAIL_SHAPE.test(normalized) && normalized.length <= 254 ? await repo.findUserByEmail(normalized) : null;
        const attempt = await attemptPasswordLogin(repo, user, password, now);
        if (attempt.ok) {
          await recordAuthEvent(repo, { event: 'login_success', actorUserId: attempt.user.id, subjectUserId: attempt.user.id, email: normalized, ...ctx, at: now });
        } else {
          await recordAuthEvent(repo, {
            event: attempt.lockedNow && attempt.reason !== 'locked' ? 'login_locked' : 'login_failed',
            subjectUserId: user?.id ?? null,
            email: normalized,
            ...ctx,
            detail: { reason: attempt.reason },
            at: now,
          });
        }
        return attempt;
      }, floorMs);

      if (!result.ok) return reply.code(INVALID_CREDENTIALS.statusCode).send(INVALID_CREDENTIALS.body);
      await openUserSession(fastify, request, result.user, 'password');
      return reply.code(200).send({ status: 'ok', user: publicUser(result.user) });
    },
  );

  // ── POST /auth/login/emergency (D10/AC19) ──
  fastify.post<{ Body: { password: string } }>(
    '/auth/login/emergency',
    {
      onRequest: publicJson,
      config: rateLimit('emergency', 'ip+legacy'),
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } },
        },
      },
    },
    async (request, reply) => {
      const owner = await legacyLogin(request, request.body.password, 'emergency');
      if (!owner) return reply.code(INVALID_CREDENTIALS.statusCode).send(INVALID_CREDENTIALS.body);
      await openUserSession(fastify, request, owner, 'legacy');
      return reply.code(200).send({ status: 'ok', user: publicUser(owner), legacy: true });
    },
  );

  // ── POST /auth/signup (AC10) — sempre 202; só e-mail novo cria `pending_approval` ──
  fastify.post<{ Body: SignupBody }>(
    '/auth/signup',
    {
      onRequest: publicJson,
      config: rateLimit('signup', 'ip'),
      schema: {
        body: {
          type: 'object',
          required: ['name', 'email'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 120 },
            email: { type: 'string', minLength: 3, maxLength: 254 },
            note: { type: 'string', maxLength: 280 },
            website: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const name = stripControl(request.body.name, false);
      const email = normalizeEmail(request.body.email);
      const note = request.body.note ? stripControl(request.body.note, true) || null : null;
      if ([...name].length < 2 || !EMAIL_SHAPE.test(email)) {
        return reply.code(400).send({ code: 'invalid_signup' });
      }
      const now = new Date();
      const ctx = requestContext(fastify, request);
      await withTimeFloor(async () => {
        if (request.body.website && request.body.website.trim() !== '') {
          await recordAuthEvent(repo, { event: 'signup_ignored', email, ...ctx, detail: { reason: 'honeypot' }, at: now });
          return;
        }
        if ((await repo.countUsersByStatus('pending_approval')) >= PENDING_SIGNUP_CAP) {
          fastify.log.warn({ cap: PENDING_SIGNUP_CAP }, 'auth: teto de solicitações pendentes atingido — cadastro ignorado');
          await recordAuthEvent(repo, { event: 'signup_ignored', email, ...ctx, detail: { reason: 'pending_cap', cap: PENDING_SIGNUP_CAP }, at: now });
          return;
        }
        const { created } = await repo.createPendingUser({ email, name, note, now });
        if (!created) {
          await recordAuthEvent(repo, { event: 'signup_ignored', email, ...ctx, detail: { reason: 'existing' }, at: now });
          return;
        }
        const user = await repo.findUserByEmail(email);
        await recordAuthEvent(repo, { event: 'signup_requested', subjectUserId: user?.id ?? null, email, ...ctx, at: now });
        runInBackground(fastify, 'aviso de nova solicitação', () =>
          notifyOwnersOfSignup(mailDeps(), { id: user?.id ?? null, name, email }, new Date()),
        );
      }, floorMs);
      return reply.code(REQUEST_RECEIVED.statusCode).send(REQUEST_RECEIVED.body);
    },
  );

  // ── POST /auth/forgot (AC11) — sempre 202; e-mail sai depois da resposta ──
  fastify.post<{ Body: { email: string } }>(
    '/auth/forgot',
    {
      onRequest: publicJson,
      config: rateLimit('forgot', 'ip+email'),
      schema: {
        body: { type: 'object', required: ['email'], properties: { email: { type: 'string', maxLength: 320 } } },
      },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const ctx = requestContext(fastify, request);
      await withTimeFloor(async () => {
        if (!EMAIL_SHAPE.test(email) || email.length > 254) return;
        runInBackground(fastify, 'esqueci a senha', async () => {
          const now = new Date();
          const user = await repo.findUserByEmail(email);
          if (!user) return;
          const sent = await sendPasswordLinkFor(mailDeps(), user, now, ctx);
          if (!sent) {
            await recordAuthEvent(repo, { event: 'reset_requested', subjectUserId: user.id, email, ...ctx, detail: { result: 'ignored', status: user.status }, at: now });
            return;
          }
          await recordAuthEvent(repo, { event: 'reset_requested', subjectUserId: user.id, email, ...ctx, detail: { result: sent.mail, purpose: sent.purpose }, at: now });
        });
      }, floorMs);
      return reply.code(REQUEST_RECEIVED.statusCode).send(REQUEST_RECEIVED.body);
    },
  );

  // ── POST /auth/password/validate (AC12) — não consome ──
  fastify.post<{ Body: { token: string } }>(
    '/auth/password/validate',
    {
      onRequest: publicJson,
      config: rateLimit('passwordValidate', 'ip+token'),
      schema: { body: { type: 'object', required: ['token'], properties: { token: { type: 'string', maxLength: 200 } } } },
    },
    async (request, reply) => {
      const found = await findLinkPurpose(fastify, request.body.token, new Date());
      if (!found) return reply.code(200).header('cache-control', 'no-store').send({ valid: false });
      const user = await repo.findUserById(found.userId);
      const valid = !!user && PASSWORD_SETTABLE_STATUSES.includes(user.status);
      return reply.code(200).header('cache-control', 'no-store').send({ valid });
    },
  );

  // ── POST /auth/password/set (AC12 + SEC-003) — consome o link, grava a senha e ABRE sessão ──
  fastify.post<{ Body: { token: string; password: string } }>(
    '/auth/password/set',
    {
      onRequest: publicJson,
      config: rateLimit('passwordSet', 'ip+token'),
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          properties: { token: { type: 'string', maxLength: 200 }, password: { type: 'string', maxLength: 1024 } },
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const ctx = requestContext(fastify, request);
      // Link checado ANTES do argon2 (barato): token inventado não custa um hash.
      const found = await findLinkPurpose(fastify, request.body.token, now);
      const user = found ? await repo.findUserById(found.userId) : null;
      if (!found || !user || !PASSWORD_SETTABLE_STATUSES.includes(user.status)) {
        return reply.code(INVALID_OR_EXPIRED_LINK.statusCode).send(INVALID_OR_EXPIRED_LINK.body);
      }
      const policy = validatePasswordPolicy(request.body.password, user.email);
      if (!policy.ok) return reply.code(400).send({ code: 'weak_password', violations: policy.violations });

      const passwordHash = await hashPassword(request.body.password);
      const redeemed = await redeemAuthToken(repo, { token: request.body.token, purpose: found.purpose, now, passwordHash });
      if (redeemed.status !== 'valid') return reply.code(INVALID_OR_EXPIRED_LINK.statusCode).send(INVALID_OR_EXPIRED_LINK.body);

      await recordAuthEvent(repo, {
        event: found.purpose === 'invite' ? 'password_set' : 'reset_used',
        actorUserId: user.id,
        subjectUserId: user.id,
        email: user.email,
        ...ctx,
        at: now,
      });
      const fresh = (await repo.findUserById(user.id)) ?? user;
      await openUserSession(fastify, request, fresh, 'password');
      return reply.code(200).send({ status: 'ok', user: publicUser(fresh) });
    },
  );

  // ── POST /auth/password/change (AC13) — autenticada; revoga as OUTRAS sessões ──
  fastify.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/auth/password/change',
    {
      onRequest: sessionJson,
      preHandler: fastify.authenticate,
      config: rateLimit('passwordChange', 'ip'),
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: { currentPassword: { type: 'string', maxLength: 1024 }, newPassword: { type: 'string', maxLength: 1024 } },
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const userId = request.session.userId;
      const user = userId ? await repo.findUserById(userId) : null;
      if (!user || user.status !== 'active' || !user.passwordHash) {
        // Sessão de emergência/owner sem senha: troca só pelo link (esqueci a senha).
        await verifyPassword(null, request.body.currentPassword);
        return reply.code(400).send({ code: 'invalid_current_password' });
      }
      const locked = isLocked(user, now);
      const valid = await verifyPassword(user.passwordHash, request.body.currentPassword);
      if (locked || !valid) {
        if (!locked) await repo.updateThrottle(user.id, (prev) => nextFailureState(prev, now));
        return reply.code(400).send({ code: 'invalid_current_password' });
      }
      const policy = validatePasswordPolicy(request.body.newPassword, user.email);
      if (!policy.ok) return reply.code(400).send({ code: 'weak_password', violations: policy.violations });
      const changed = await repo.changePassword({
        userId: user.id,
        passwordHash: await hashPassword(request.body.newPassword),
        expectedCurrentHash: user.passwordHash,
        now,
        keepSidHash: hashSessionId(request.session.sessionId),
      });
      if (!changed) return reply.code(409).send({ code: 'password_changed_concurrently' });
      await recordAuthEvent(repo, { event: 'password_changed', actorUserId: user.id, subjectUserId: user.id, email: user.email, ...requestContext(fastify, request), at: now });
      return reply.code(200).send({ status: 'ok' });
    },
  );

  // ── POST /auth/logout (AC13) ──
  fastify.post('/auth/logout', { onRequest: sessionNoBody }, async (request, reply) => {
    const userId = request.session?.userId;
    if (userId) {
      await recordAuthEvent(repo, { event: 'logout', actorUserId: userId, subjectUserId: userId, ...requestContext(fastify, request) }).catch(() => undefined);
    }
    await request.session.destroy();
    return reply.code(200).send({ status: 'ok' });
  });

  // ── GET /auth/me (AC14) — campo aditivo `user` (+ `legacy`); relê o usuário a cada chamada ──
  // Story 13.10 (SEC-001): o backoffice (requireVerifiedApiSession) valida aqui que o cookie
  // corresponde a uma sessão REAL — presença do cookie não basta.
  fastify.get('/auth/me', { preHandler: fastify.authenticate }, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const userId = request.session.userId;
    if (!userId) return reply.code(200).send({ authenticated: true });
    const user = await repo.findUserById(userId);
    // Sessão de emergência morre junto com a emergência (LEGACY_LOGIN_UNTIL passou / desligada).
    const legacyExpired = request.session.via === 'legacy' && !legacyLoginState(config, new Date()).enabled;
    if (legacyExpired || !sessionUserValid(user, request.session.via)) {
      await request.session.destroy();
      return reply.code(401).send(UNAUTHORIZED);
    }
    const legacy = request.session.via === 'legacy';
    return reply.code(200).send({ authenticated: true, user: publicUser(user), ...(legacy ? { legacy: true } : {}) });
  });
};

export default authRoutes;

// Story 22.1a-1 · repositório de contas (users, auth_tokens, auth_audit_log, auth_sessions).
//
// Contrato único com duas implementações: Drizzle/Postgres (aqui) e memória
// (`__tests__/helpers/auth-memory-repo.ts`, usada pelos testes de rota da 22.1a-2). As duas passam
// pelo MESMO teste de contrato (`__tests__/helpers/auth-repo-contract.ts`).
//
// Regras de segurança que vivem aqui (e não no chamador):
//  - o banco só recebe `token_hash` (sha256 hex) — o token em claro nunca chega a este módulo;
//  - consumo de token = UM UPDATE condicional (`used_at IS NULL AND expires_at > now`) → dois
//    consumos simultâneos: exatamente um vence (A4);
//  - emitir token novo invalida os abertos do mesmo usuário/finalidade; definir senha invalida
//    TODOS os abertos e revoga TODAS as sessões do usuário (A5), na mesma transação;
//  - nenhuma leitura devolve `password_hash` para fora sem ser pedida (só `findUserByEmail`/`ById`,
//    usadas pelo login).
// 22.1a-2: usado pelas rotas de conta (`routes/auth.routes.ts`, `routes/admin-users.routes.ts`).
import type { Database } from '@blackshop/db';
import { authAuditLog, authSessions, authTokens, users } from '@blackshop/db';
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';

export const USER_ROLES = ['owner', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['pending_approval', 'approved_pending_password', 'active', 'rejected', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const TOKEN_PURPOSES = ['invite', 'reset'] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

/** Estados em que a pessoa pode definir/redefinir a senha por link. */
export const PASSWORD_SETTABLE_STATUSES: readonly UserStatus[] = ['approved_pending_password', 'active'];

/**
 * 22.1a-2 · owner "utilizável" para a regra do último owner (A8): ativo OU aprovado aguardando
 * senha (o owner semeado pela 0102 fica assim até criar a senha — e é o único na transição).
 */
export const USABLE_OWNER_STATUSES: readonly UserStatus[] = ['active', 'approved_pending_password'];

/** Visão do usuário para a tela de usuários (sem hash, sem token, sem estado de bloqueio). */
export interface AdminUserView {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: UserStatus;
  hasPassword: boolean;
  requestedAt: Date | null;
  requestNote: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/** Destino de uma transição: um estado, ou `restore` (reativar: `active` se tem senha, senão aguardando senha). */
export type TransitionTarget = UserStatus | 'restore';

export interface TransitionInput {
  userId: string;
  /** Estados de origem aceitos. Já estar no destino ⇒ `changed: false` (idempotente). */
  from: readonly UserStatus[];
  to: TransitionTarget;
  decidedBy: string | null;
  reason?: string | null;
  now: Date;
}

export type TransitionResult =
  | { ok: true; changed: boolean; user: AuthUser }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'last_owner' };

export interface ChangePasswordInput {
  userId: string;
  passwordHash: string;
  /** Compare-and-swap: só grava se o hash atual ainda for este. */
  expectedCurrentHash: string;
  now: Date;
  /** Sessão atual (sha256 do sid) — fica; as outras do usuário são revogadas. */
  keepSidHash: string | null;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: UserStatus;
  passwordHash: string | null;
  passwordChangedAt: Date | null;
  failedLoginCount: number;
  lastFailedLoginAt: Date | null;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/** Estado do bloqueio progressivo gravado na linha do usuário. */
export interface ThrottleState {
  failedLoginCount: number;
  lastFailedLoginAt: Date | null;
  lockedUntil: Date | null;
}

export interface NewAuditEntry {
  event: string;
  actorUserId?: string | null;
  subjectUserId?: string | null;
  emailMasked?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
  at?: Date;
}

export interface AuditEntry extends Required<Omit<NewAuditEntry, 'detail' | 'at'>> {
  id: number;
  at: Date;
  detail: Record<string, unknown>;
}

export interface IssueTokenInput {
  userId: string;
  purpose: TokenPurpose;
  tokenHash: string;
  expiresAt: Date;
  createdBy?: string | null;
  now: Date;
}

export interface TokenLookup {
  tokenHash: string;
  purpose: TokenPurpose;
  now: Date;
  /** Quando informado, token de OUTRO usuário é tratado como inválido. */
  userId?: string;
}

export interface RedeemInput extends TokenLookup {
  passwordHash: string;
}

export type RedeemResult = { ok: true; userId: string } | { ok: false };

export interface AuthRepo {
  /** E-mail comparado em minúsculas. */
  findUserByEmail(email: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  /** Cria `pending_approval`; e-mail já existente (qualquer estado) ⇒ `created: false`, nada muda. */
  createPendingUser(input: { email: string; name: string; note?: string | null; now: Date }): Promise<{ created: boolean }>;
  /** Lê o estado de bloqueio SOB LOCK, aplica `next` e grava (falhas concorrentes não se perdem). */
  updateThrottle(userId: string, next: (prev: ThrottleState) => ThrottleState): Promise<ThrottleState | null>;
  /** Sucesso do login: zera falhas/bloqueio e grava `last_login_at`. */
  recordLoginSuccess(userId: string, now: Date): Promise<void>;
  /**
   * Troca só o hash (rehash de parâmetros no login). Com `expectedCurrentHash`, é compare-and-swap:
   * só grava se o hash atual ainda for o lido antes do login — uma troca de senha concorrente
   * (redefinição) nunca é sobrescrita pelo hash da senha antiga. Devolve `true` se gravou.
   */
  updatePasswordHash(userId: string, passwordHash: string, now: Date, expectedCurrentHash?: string): Promise<boolean>;
  issueToken(input: IssueTokenInput): Promise<void>;
  /** Não consome. */
  peekToken(input: TokenLookup): Promise<{ userId: string } | null>;
  /** Consumo atômico de uso único. */
  consumeToken(input: TokenLookup): Promise<{ userId: string } | null>;
  /**
   * Consome o token E grava a senha na MESMA transação: status → active, zera falhas/bloqueio,
   * invalida todos os tokens abertos e revoga todas as sessões do usuário. Usuário fora de
   * `PASSWORD_SETTABLE_STATUSES` ⇒ `{ ok: false }` e o token NÃO é gasto.
   */
  redeemTokenAndSetPassword(input: RedeemInput): Promise<RedeemResult>;
  invalidateOpenTokens(userId: string, now: Date): Promise<number>;
  /** Remove as sessões do usuário (todas, ou todas menos `exceptSidHash`). */
  revokeSessions(userId: string, exceptSidHash?: string | null): Promise<number>;
  appendAudit(entry: NewAuditEntry): Promise<void>;
  // ── 22.1a-2 ──
  /** Lista paginada (mais recentes primeiro), opcionalmente filtrada por estado. */
  listUsers(input: { status?: UserStatus; limit: number; offset: number }): Promise<{ items: AdminUserView[]; total: number }>;
  countUsersByStatus(status: UserStatus): Promise<number>;
  /** Owners (qualquer estado), do mais antigo para o mais novo. */
  listOwners(): Promise<AuthUser[]>;
  /** Quando o último token (qualquer finalidade) foi emitido para o usuário — cadência de e-mail. */
  lastTokenIssuedAt(userId: string): Promise<Date | null>;
  /**
   * Muda o estado SOB LOCK com a regra do último owner (A8): tirar o último owner utilizável de
   * `USABLE_OWNER_STATUSES` ⇒ `last_owner`. Ir para `rejected`/`disabled` invalida os tokens abertos e
   * revoga as sessões na mesma transação.
   */
  transitionUser(input: TransitionInput): Promise<TransitionResult>;
  /** Troca de senha autenticada: grava (CAS, só `active`), invalida tokens abertos e revoga as OUTRAS sessões. */
  changePassword(input: ChangePasswordInput): Promise<boolean>;
}

/** Destino efetivo de uma transição. */
export function resolveTransitionTarget(to: TransitionTarget, user: Pick<AuthUser, 'passwordHash'>): UserStatus {
  if (to !== 'restore') return to;
  return user.passwordHash ? 'active' : 'approved_pending_password';
}

const REVOKING_STATUSES: readonly UserStatus[] = ['rejected', 'disabled'];

export type TransitionPlan =
  | { ok: true; changed: boolean; target: UserStatus; revoke: boolean }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'last_owner' };

/** Regra pura da transição (as duas implementações usam a mesma). */
export function planTransition(user: AuthUser | null, input: TransitionInput, otherUsableOwners: number): TransitionPlan {
  if (!user) return { ok: false, reason: 'not_found' };
  const target = resolveTransitionTarget(input.to, user);
  if (user.status === target) return { ok: true, changed: false, target, revoke: false };
  if (!input.from.includes(user.status)) return { ok: false, reason: 'invalid_state' };
  const losesOwner =
    user.role === 'owner' && USABLE_OWNER_STATUSES.includes(user.status) && !USABLE_OWNER_STATUSES.includes(target);
  if (losesOwner && otherUsableOwners === 0) return { ok: false, reason: 'last_owner' };
  return { ok: true, changed: true, target, revoke: REVOKING_STATUSES.includes(target) };
}

export interface AdminUserExtra {
  requestedAt?: Date | null;
  requestNote?: string | null;
  decidedAt?: Date | null;
  decisionReason?: string | null;
}

export function toAdminUserView(user: AuthUser, extra: AdminUserExtra = {}): AdminUserView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    hasPassword: user.passwordHash !== null,
    requestedAt: extra.requestedAt ?? null,
    requestNote: extra.requestNote ?? null,
    decidedAt: extra.decidedAt ?? null,
    decisionReason: extra.decisionReason ?? null,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

type UserRow = typeof users.$inferSelect;

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    passwordHash: row.passwordHash,
    passwordChangedAt: row.passwordChangedAt,
    failedLoginCount: row.failedLoginCount,
    lastFailedLoginAt: row.lastFailedLoginAt,
    lockedUntil: row.lockedUntil,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}

/** Normalização única de e-mail (trim + minúsculas). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function openTokenWhere(input: TokenLookup) {
  const conds = [
    eq(authTokens.tokenHash, input.tokenHash),
    eq(authTokens.purpose, input.purpose),
    isNull(authTokens.usedAt),
    gt(authTokens.expiresAt, input.now),
  ];
  if (input.userId !== undefined) conds.push(eq(authTokens.userId, input.userId));
  return and(...conds);
}

async function invalidateOpen(tx: Tx | Database, userId: string, now: Date, purpose?: TokenPurpose): Promise<number> {
  const conds = [eq(authTokens.userId, userId), isNull(authTokens.usedAt)];
  if (purpose) conds.push(eq(authTokens.purpose, purpose));
  const rows = await tx.update(authTokens).set({ usedAt: now }).where(and(...conds)).returning({ id: authTokens.id });
  return rows.length;
}

export function createDrizzleAuthRepo(db: Database): AuthRepo {
  return {
    async findUserByEmail(email) {
      const [row] = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`)
        .limit(1);
      return row ? toAuthUser(row) : null;
    },

    async findUserById(id) {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ? toAuthUser(row) : null;
    },

    async createPendingUser({ email, name, note, now }) {
      const rows = await db
        .insert(users)
        .values({
          email: normalizeEmail(email),
          name,
          role: 'member',
          status: 'pending_approval',
          requestedAt: now,
          requestNote: note ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: users.id });
      return { created: rows.length > 0 };
    },

    async updateThrottle(userId, next) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            failedLoginCount: users.failedLoginCount,
            lastFailedLoginAt: users.lastFailedLoginAt,
            lockedUntil: users.lockedUntil,
          })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!row) return null;
        const state = next(row);
        await tx
          .update(users)
          .set({
            failedLoginCount: state.failedLoginCount,
            lastFailedLoginAt: state.lastFailedLoginAt,
            lockedUntil: state.lockedUntil,
          })
          .where(eq(users.id, userId));
        return state;
      });
    },

    async recordLoginSuccess(userId, now) {
      await db
        .update(users)
        .set({ failedLoginCount: 0, lastFailedLoginAt: null, lockedUntil: null, lastLoginAt: now, updatedAt: now })
        .where(eq(users.id, userId));
    },

    async updatePasswordHash(userId, passwordHash, now, expectedCurrentHash) {
      const where =
        expectedCurrentHash === undefined
          ? eq(users.id, userId)
          : and(eq(users.id, userId), eq(users.passwordHash, expectedCurrentHash));
      const rows = await db.update(users).set({ passwordHash, updatedAt: now }).where(where).returning({ id: users.id });
      return rows.length > 0;
    },

    async issueToken({ userId, purpose, tokenHash, expiresAt, createdBy, now }) {
      await db.transaction(async (tx) => {
        await invalidateOpen(tx, userId, now, purpose);
        await tx.insert(authTokens).values({ userId, purpose, tokenHash, expiresAt, createdBy: createdBy ?? null, createdAt: now });
      });
    },

    async peekToken(input) {
      const [row] = await db.select({ userId: authTokens.userId }).from(authTokens).where(openTokenWhere(input)).limit(1);
      return row ?? null;
    },

    async consumeToken(input) {
      const [row] = await db
        .update(authTokens)
        .set({ usedAt: input.now })
        .where(openTokenWhere(input))
        .returning({ userId: authTokens.userId });
      return row ?? null;
    },

    async redeemTokenAndSetPassword(input) {
      const NOT_SETTABLE = Symbol('not-settable');
      try {
        return await db.transaction(async (tx): Promise<RedeemResult> => {
          const [token] = await tx
            .update(authTokens)
            .set({ usedAt: input.now })
            .where(openTokenWhere(input))
            .returning({ userId: authTokens.userId });
          if (!token) return { ok: false };
          const [updated] = await tx
            .update(users)
            .set({
              passwordHash: input.passwordHash,
              passwordChangedAt: input.now,
              status: 'active',
              failedLoginCount: 0,
              lastFailedLoginAt: null,
              lockedUntil: null,
              updatedAt: input.now,
            })
            .where(and(eq(users.id, token.userId), inArray(users.status, [...PASSWORD_SETTABLE_STATUSES])))
            .returning({ id: users.id });
          // Desfaz o consumo: conta fora de estado não gasta o token (e nada muda).
          if (!updated) throw NOT_SETTABLE;
          await invalidateOpen(tx, token.userId, input.now);
          await tx.delete(authSessions).where(eq(authSessions.userId, token.userId));
          return { ok: true, userId: token.userId };
        });
      } catch (err) {
        if (err === NOT_SETTABLE) return { ok: false };
        throw err;
      }
    },

    async invalidateOpenTokens(userId, now) {
      return invalidateOpen(db, userId, now);
    },

    async revokeSessions(userId, exceptSidHash) {
      const rows = await db.delete(authSessions).where(sessionsOf(userId, exceptSidHash)).returning({ sidHash: authSessions.sidHash });
      return rows.length;
    },

    async appendAudit(entry) {
      await db.insert(authAuditLog).values({
        event: entry.event,
        actorUserId: entry.actorUserId ?? null,
        subjectUserId: entry.subjectUserId ?? null,
        emailMasked: entry.emailMasked ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        detail: entry.detail ?? {},
        ...(entry.at ? { at: entry.at } : {}),
      });
    },

    async listUsers({ status, limit, offset }) {
      const where = status ? eq(users.status, status) : undefined;
      const rows = await db
        .select()
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt), asc(users.id))
        .limit(limit)
        .offset(offset);
      const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(where);
      return { items: rows.map((row) => toAdminUserView(toAuthUser(row), row)), total: Number(count?.n ?? 0) };
    },

    async countUsersByStatus(status) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.status, status));
      return Number(row?.n ?? 0);
    },

    async listOwners() {
      const rows = await db.select().from(users).where(eq(users.role, 'owner')).orderBy(asc(users.createdAt), asc(users.id));
      return rows.map(toAuthUser);
    },

    async lastTokenIssuedAt(userId) {
      const [row] = await db
        .select({ at: authTokens.createdAt })
        .from(authTokens)
        .where(eq(authTokens.userId, userId))
        .orderBy(desc(authTokens.createdAt))
        .limit(1);
      return row?.at ?? null;
    },

    async transitionUser(input) {
      return db.transaction(async (tx): Promise<TransitionResult> => {
        // Trava as linhas de owner utilizáveis ANTES da do alvo (ordem fixa por id): dois "desativar"
        // simultâneos de owners diferentes não conseguem, juntos, zerar os owners (A8).
        const owners = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, 'owner'), inArray(users.status, [...USABLE_OWNER_STATUSES])))
          .orderBy(asc(users.id))
          .for('update');
        const [row] = await tx.select().from(users).where(eq(users.id, input.userId)).for('update');
        const user = row ? toAuthUser(row) : null;
        const plan = planTransition(user, input, owners.filter((o) => o.id !== input.userId).length);
        if (!plan.ok) return plan;
        if (!plan.changed || !user) return { ok: true, changed: false, user: user! };
        const [updated] = await tx
          .update(users)
          .set({
            status: plan.target,
            decidedBy: input.decidedBy,
            decidedAt: input.now,
            decisionReason: input.reason ?? null,
            updatedAt: input.now,
          })
          .where(eq(users.id, input.userId))
          .returning();
        if (plan.revoke) {
          await invalidateOpen(tx, input.userId, input.now);
          await tx.delete(authSessions).where(eq(authSessions.userId, input.userId));
        }
        return { ok: true, changed: true, user: toAuthUser(updated!) };
      });
    },

    async changePassword({ userId, passwordHash, expectedCurrentHash, now, keepSidHash }) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(users)
          .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
          .where(and(eq(users.id, userId), eq(users.passwordHash, expectedCurrentHash), eq(users.status, 'active')))
          .returning({ id: users.id });
        if (rows.length === 0) return false;
        await invalidateOpen(tx, userId, now);
        await tx.delete(authSessions).where(sessionsOf(userId, keepSidHash));
        return true;
      });
    },
  };
}

function sessionsOf(userId: string, exceptSidHash?: string | null) {
  return exceptSidHash
    ? and(eq(authSessions.userId, userId), ne(authSessions.sidHash, exceptSidHash))
    : eq(authSessions.userId, userId);
}

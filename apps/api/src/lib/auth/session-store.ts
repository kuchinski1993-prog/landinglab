// Story 22.1a-2 · D5/AC17 (A5) — loja de sessão do @fastify/session na tabela `auth_sessions`.
//
// - Chave = sha256(sid) em hex: o banco nunca guarda o id que vale como cookie.
// - Sobrevive a deploy/restart; revogável por usuário (`DELETE … WHERE user_id`).
// - Só sessões COM usuário são gravadas (`user_id NOT NULL`); sessão sem usuário não persiste.
// - Anti-ressurreição: uma sessão só é INSERIDA quando foi marcada como nova (`markFreshSession`,
//   chamada no login). O "rolling" do @fastify/session regrava a sessão a cada resposta; para uma
//   sessão já existente isso é só UPDATE — se ela foi revogada no meio da requisição, a linha não
//   volta (0 linhas atualizadas).
// - Expiração: `expires_at` respeitado na leitura; varredura leve de expiradas no máximo a cada
//   `sweepIntervalMs` (sem job novo).
import { createHash } from 'node:crypto';

import type { Database } from '@blackshop/db';
import { authSessions } from '@blackshop/db';
import { and, eq, gt, lt } from 'drizzle-orm';

const DEFAULT_TTL_MS = 86_400_000;
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60_000;
const TEXT_MAX = 200;

export function hashSessionId(sid: string): string {
  return createHash('sha256').update(sid, 'utf8').digest('hex');
}

const freshSessions = new WeakSet<object>();

/** Marca a sessão recém-criada no login (só ela pode virar linha nova na loja). */
export function markFreshSession(session: object): void {
  freshSessions.add(session);
}

export function isFreshSession(session: object): boolean {
  return freshSessions.has(session);
}

type Callback = (err?: unknown) => void;
type GetCallback = (err: unknown, session?: Record<string, unknown> | null) => void;

/** Interface mínima de loja do @fastify/session. */
export interface SessionStoreLike {
  set(sid: string, session: Record<string, unknown>, callback: Callback): void;
  get(sid: string, callback: GetCallback): void;
  destroy(sid: string, callback: Callback): void;
}

interface SessionShape {
  userId?: unknown;
  clientIp?: unknown;
  userAgent?: unknown;
  cookie?: { expires?: unknown; toJSON?: () => unknown };
}

export function sessionExpiry(session: SessionShape, now: number): Date {
  const raw = session.cookie?.expires;
  const at = raw instanceof Date ? raw.getTime() : typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(at) ? new Date(at) : new Date(now + DEFAULT_TTL_MS);
}

/** Cópia serializável (o Cookie vira o JSON dele). */
export function serializeSession(session: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(session)) as Record<string, unknown>;
}

function clip(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? [...value].slice(0, TEXT_MAX).join('') : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DrizzleSessionStoreOptions {
  now?: () => number;
  sweepIntervalMs?: number;
}

export function createDrizzleSessionStore(getDb: () => Database, opts: DrizzleSessionStoreOptions = {}): SessionStoreLike {
  const now = opts.now ?? Date.now;
  const sweepEvery = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  let lastSweep = 0;

  async function maybeSweep(db: Database): Promise<void> {
    const t = now();
    if (t - lastSweep < sweepEvery) return;
    lastSweep = t;
    await db.delete(authSessions).where(lt(authSessions.expiresAt, new Date(t)));
  }

  async function set(sid: string, session: Record<string, unknown>): Promise<void> {
    const shape = session as SessionShape;
    const userId = typeof shape.userId === 'string' && UUID.test(shape.userId) ? shape.userId : null;
    if (!userId) return;
    const db = getDb();
    const t = now();
    const sidHash = hashSessionId(sid);
    const data = serializeSession(session);
    const expiresAt = sessionExpiry(shape, t);
    const lastSeenAt = new Date(t);
    if (isFreshSession(session)) {
      await db
        .insert(authSessions)
        .values({ sidHash, userId, data, expiresAt, createdAt: lastSeenAt, lastSeenAt, userAgent: clip(shape.userAgent), ip: clip(shape.clientIp) })
        .onConflictDoUpdate({ target: authSessions.sidHash, set: { data, expiresAt, lastSeenAt } });
    } else {
      await db
        .update(authSessions)
        .set({ data, expiresAt, lastSeenAt })
        .where(and(eq(authSessions.sidHash, sidHash), eq(authSessions.userId, userId)));
    }
    await maybeSweep(db);
  }

  async function get(sid: string): Promise<Record<string, unknown> | null> {
    const [row] = await getDb()
      .select({ data: authSessions.data })
      .from(authSessions)
      .where(and(eq(authSessions.sidHash, hashSessionId(sid)), gt(authSessions.expiresAt, new Date(now()))))
      .limit(1);
    return row ? (row.data as Record<string, unknown>) : null;
  }

  async function destroy(sid: string): Promise<void> {
    await getDb().delete(authSessions).where(eq(authSessions.sidHash, hashSessionId(sid)));
  }

  return {
    set(sid, session, callback) {
      set(sid, session).then(() => callback(), callback);
    },
    get(sid, callback) {
      get(sid).then((s) => callback(null, s), (err: unknown) => callback(err));
    },
    destroy(sid, callback) {
      destroy(sid).then(() => callback(), callback);
    },
  };
}

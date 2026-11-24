// Story 19.3a — leitura e escrita de `store_modules` (migration 0096).
//
// Regras:
//   • Ausência de linha = padrão do módulo (`defaultEnabled`, hoje "ligado").
//   • `setModule` grava estado + evento de auditoria (`store_module_events`) na
//     MESMA transação; só grava evento quando o estado muda (PATCH idempotente).
//   • Concorrência: a linha é travada (`FOR UPDATE`); se não existe, o INSERT
//     com `ON CONFLICT DO NOTHING` serializa dois pedidos simultâneos — o
//     segundo relê a linha travada e vira "sem mudança" (um evento só).
//   • Desligar só esconde menu/pendência da home. Nada aqui bloqueia rota/fila.
import {
  isKnownModule,
  moduleMeta,
  resolveModuleStates,
  type ModuleState,
} from '@blackshop/shared/modules';
import { sql, type SQL } from 'drizzle-orm';

export interface ExecDb {
  execute: (query: SQL) => Promise<unknown>;
}

export interface TxDb extends ExecDb {
  transaction: <T>(fn: (tx: ExecDb) => Promise<T>) => Promise<T>;
}

/** Ator da auditoria: hoje o painel tem um único usuário (o dono). */
export const OWNER_ACTOR = 'owner';

/** Chaves de cache da home que dependem dos módulos ligados (invalidadas no PATCH). */
export function homeCacheKeys(storeId: string): string[] {
  return [`home:v1:attention:${storeId}`, `home:v1:modules:${storeId}`];
}

function toRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export async function storeExists(db: ExecDb, storeId: string): Promise<boolean> {
  const found = toRows<{ id: string }>(await db.execute(sql`SELECT id FROM stores WHERE id = ${storeId} LIMIT 1`));
  return found.length > 0;
}

async function readRows(db: ExecDb, storeId: string): Promise<Array<{ module: string; enabled: boolean }>> {
  return toRows<{ module: string; enabled: boolean }>(
    await db.execute(sql`SELECT module, enabled FROM store_modules WHERE store_id = ${storeId}`),
  );
}

/** Postgres 42P01 (undefined_table): a migration 0096 ainda não foi aplicada neste banco. */
export function isUndefinedTable(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '42P01' || e?.cause?.code === '42P01';
}

export interface ModulesLog {
  warn: (obj: object, msg: string) => void;
}

const READ_FAILURE_LOG_INTERVAL_MS = 5 * 60_000;
const lastReadFailureLog = new Map<string, number>();

/**
 * Loga falha de leitura de `store_modules` sem inundar o log: tabela inexistente
 * (deploy antes da 0096) uma vez por processo; demais erros no máximo 1 a cada
 * 5 min por loja e por ponto de leitura. Devolve se logou.
 */
export function reportModulesReadFailure(
  log: ModulesLog,
  err: unknown,
  ctx: { storeId: string; where: string },
  now = Date.now(),
): boolean {
  const missing = isUndefinedTable(err);
  const key = missing ? '42P01' : `${ctx.where}:${ctx.storeId}`;
  const last = lastReadFailureLog.get(key);
  if (last !== undefined && (missing || now - last < READ_FAILURE_LOG_INTERVAL_MS)) return false;
  lastReadFailureLog.set(key, now);
  if (missing)
    log.warn(
      { err, storeId: ctx.storeId, where: ctx.where },
      'store_modules não existe (migration 0096 pendente): todos os módulos ligados (aviso único por processo)',
    );
  else log.warn({ err, storeId: ctx.storeId, where: ctx.where }, 'store_modules indisponível: todos os módulos ligados');
  return true;
}

/** Testes: zera o controle de logs. */
export function resetModulesLogThrottle(): void {
  lastReadFailureLog.clear();
}

/**
 * Estado efetivo de todos os módulos da loja, ou `null` se a loja não existe.
 * Tabela ainda não criada (42P01) = sem linhas = tudo ligado (deploy não depende
 * da ordem da migration). Use fora de transação: o erro abortaria a transação.
 */
export async function getModuleStates(
  db: ExecDb,
  storeId: string,
  log?: ModulesLog,
): Promise<ModuleState[] | null> {
  if (!(await storeExists(db, storeId))) return null;
  let rows: Array<{ module: string; enabled: boolean }>;
  try {
    rows = await readRows(db, storeId);
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
    if (log) reportModulesReadFailure(log, err, { storeId, where: 'get-modules' });
    rows = [];
  }
  return resolveModuleStates(rows);
}

/** Ids desligados na loja (sem validar a loja; `sistema` nunca entra). */
export async function disabledModules(db: ExecDb, storeId: string): Promise<Set<string>> {
  const states = resolveModuleStates(await readRows(db, storeId));
  return new Set(states.filter((s) => !s.enabled).map((s) => s.id));
}

export type ModuleToggleError = 'plataforma.module_unknown' | 'plataforma.module_always_on';

/** O módulo pode ser ligado/desligado? (antes de qualquer escrita) */
export function validateModuleToggle(module: string): ModuleToggleError | null {
  if (!isKnownModule(module)) return 'plataforma.module_unknown';
  if (moduleMeta(module)?.alwaysOn) return 'plataforma.module_always_on';
  return null;
}

export interface SetModuleInput {
  storeId: string;
  module: string;
  enabled: boolean;
  actor: string;
}

export type SetModuleResult =
  | { status: 'store_not_found' }
  | { status: 'ok'; changed: boolean; from: boolean; to: boolean };

function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23503' || e?.cause?.code === '23503';
}

/**
 * Define o estado do módulo na loja (idempotente). Chame `validateModuleToggle`
 * antes: aqui só módulos conhecidos e desligáveis devem chegar.
 */
export async function setModule(db: TxDb, input: SetModuleInput): Promise<SetModuleResult> {
  const { storeId, module, enabled, actor } = input;
  const meta = moduleMeta(module);
  if (!meta || meta.alwaysOn) throw new Error(`setModule: módulo "${module}" não pode ser alterado`);
  try {
    return await db.transaction(async (tx): Promise<SetModuleResult> => {
      if (!(await storeExists(tx, storeId))) return { status: 'store_not_found' };

      const lock = async (): Promise<boolean | null> => {
        const [row] = toRows<{ enabled: boolean }>(
          await tx.execute(
            sql`SELECT enabled FROM store_modules WHERE store_id = ${storeId} AND module = ${module} FOR UPDATE`,
          ),
        );
        return row ? row.enabled === true : null;
      };

      let current = await lock();
      if (current === null) {
        // Sem linha = padrão. Igual ao pedido → nada a gravar.
        if (meta.defaultEnabled === enabled) return { status: 'ok', changed: false, from: enabled, to: enabled };
        const inserted = toRows<{ module: string }>(
          await tx.execute(
            sql`INSERT INTO store_modules (store_id, module, enabled)
                VALUES (${storeId}, ${module}, ${enabled})
                ON CONFLICT (store_id, module) DO NOTHING
                RETURNING module`,
          ),
        );
        if (inserted.length > 0) {
          await tx.execute(
            sql`INSERT INTO store_module_events (store_id, module, from_enabled, to_enabled, actor)
                VALUES (${storeId}, ${module}, ${meta.defaultEnabled}, ${enabled}, ${actor})`,
          );
          return { status: 'ok', changed: true, from: meta.defaultEnabled, to: enabled };
        }
        // Outro pedido gravou a linha no meio do caminho: relê travado.
        current = await lock();
        if (current === null) throw new Error('setModule: linha sumiu durante a gravação');
      }

      if (current === enabled) return { status: 'ok', changed: false, from: current, to: enabled };
      await tx.execute(
        sql`UPDATE store_modules SET enabled = ${enabled}, updated_at = now()
            WHERE store_id = ${storeId} AND module = ${module}`,
      );
      await tx.execute(
        sql`INSERT INTO store_module_events (store_id, module, from_enabled, to_enabled, actor)
            VALUES (${storeId}, ${module}, ${current}, ${enabled}, ${actor})`,
      );
      return { status: 'ok', changed: true, from: current, to: enabled };
    });
  } catch (err) {
    // Loja apagada entre a checagem e o INSERT: a FK barra a linha órfã.
    if (isForeignKeyViolation(err)) return { status: 'store_not_found' };
    throw err;
  }
}

export interface RedisDelLike {
  status?: string;
  del?: (...keys: string[]) => Promise<unknown>;
}

/**
 * Apaga o cache da home da loja (best-effort, teto de 150 ms). Sem Redis ou com
 * Redis fora, o TTL curto (30/60 s) cobre. Devolve se a invalidação rodou.
 */
export async function invalidateModuleCaches(
  redis: RedisDelLike | null,
  storeId: string,
  onError?: (err: unknown) => void,
  timeoutMs = 150,
): Promise<boolean> {
  if (!redis || typeof redis.del !== 'function') return false;
  if (redis.status !== undefined && redis.status !== 'ready') return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      redis.del(...homeCacheKeys(storeId)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('redis del timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch (err) {
    onError?.(err);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

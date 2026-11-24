// Story 20.3 — consultas da home do painel ("Início" da conta e "Visão geral"
// da loja). Um bloco = uma função, chamada por um endpoint próprio em
// routes/home.routes.ts (falha e lentidão isoladas por bloco).
//
// Regras (Decisões 2-5 e 9 da story):
//  • Somente LEITURA: cada bloco roda numa transação `READ ONLY` com
//    `statement_timeout` (o banco recusa qualquer escrita). As tabelas do
//    Atendimento (`inbound_emails`, `refund_tickets`) e do Tracker
//    (`tracker_*`) só recebem SELECT agregado — nenhuma lógica dessas áreas é
//    chamada ou alterada.
//  • Cada fonte de venda entra na loja do próprio `store_id`: `orders`
//    (Shopify) e `landing_orders` (checkout Stripe das landings). Fontes e
//    moedas NUNCA são somadas entre si.
//  • "Hoje / 7 dias / 30 dias" no fuso da loja (`stores.settings.timezone`,
//    senão America/Sao_Paulo), comparados com o período anterior equivalente
//    (mesma duração, terminando no mesmo horário do dia).
//  • `tracking_events` não é consultada (sem índice de data e com store_id
//    fixo); "sessões rastreadas" vêm de `tracking_sessions`.

import { minorUnitsToMajor } from '@blackshop/pricing';
import { sql, type SQL } from 'drizzle-orm';

import { folderCondition } from './inbox-mail.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- aceita o db e a transação do drizzle */
export type HomeDb = {
  execute: (query: SQL) => Promise<any>;
  /** Transação aninhada = SAVEPOINT do driver (postgres.js exige o savepoint dele para isolar erros). */
  transaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export const LANDINGLAB_TENANT_ID = 'l0i';
export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
export const MIN_SESSIONS_FOR_CONVERSION = 30;
export const HOME_STATEMENT_TIMEOUT_MS = 3000;

export const HOME_RANGES = ['today', '7d', '30d'] as const;
export type HomeRange = (typeof HOME_RANGES)[number];

export function isHomeRange(value: unknown): value is HomeRange {
  return typeof value === 'string' && (HOME_RANGES as readonly string[]).includes(value);
}

/** Dias do período (contando hoje). */
const RANGE_DAYS: Record<HomeRange, number> = { today: 1, '7d': 7, '30d': 30 };

/** Status de pedido Shopify que contam como venda (valor bruto). */
export const SHOPIFY_PAID_STATUSES = ['paid', 'partially_paid', 'partially_refunded'] as const;
/** Status de pedido das landings (Stripe) que contam como venda. */
export const LANDING_PAID_STATUSES = ['paid', 'preparing', 'shipped', 'delivered'] as const;

// ─── Utilidades ────────────────────────────────────────────────────────

function list(values: readonly string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

async function rows<T>(db: HomeDb, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown;
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: unknown };
  return Array.isArray(maybe.rows) ? (maybe.rows as T[]) : [];
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Arredonda para 2 casas sem erro de ponto flutuante visível. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Variação percentual; período anterior vazio → null ("—", nunca Infinity/NaN). */
export function changePct(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return round2(((current - previous) / previous) * 100);
}

/** Fuso válido da loja ou o padrão (Brasília). */
export function resolveTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() });
    return value.trim();
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function timezoneLabel(tz: string): string {
  return tz === DEFAULT_TIMEZONE ? 'horário de Brasília' : `fuso ${tz}`;
}

// ─── Execução protegida ───────────────────────────────────────────────

export interface TransactionalDb extends HomeDb {
  transaction: <T>(fn: (tx: HomeDb) => Promise<T>) => Promise<T>;
}

/** Prazo total de um bloco (todas as instruções somadas), além do limite por instrução. */
export const HOME_BLOCK_BUDGET_MS = 6000;

/** Estouro do prazo do bloco: mesmo código do statement_timeout (57014) para virar HOME_BLOCK_TIMEOUT. */
export class HomeBudgetExceededError extends Error {
  readonly code = '57014';
  constructor() {
    super('home block budget exceeded');
    this.name = 'HomeBudgetExceededError';
  }
}

export interface ReadOnlyOptions {
  /** Limite por instrução (statement_timeout). */
  statementTimeoutMs?: number;
  /** Prazo total do bloco: a cada instrução o statement_timeout cai para o tempo que resta. */
  budgetMs?: number;
}

/**
 * Roda `fn` numa transação somente leitura (uma conexão só) com limite de
 * tempo no banco: por instrução (`statement_timeout`) e um prazo total do
 * bloco — quando o que resta fica abaixo do limite por instrução, o
 * `statement_timeout` é reduzido; acabou o prazo, nenhuma instrução nova roda.
 * Qualquer INSERT/UPDATE/DELETE dentro dela falha no próprio Postgres.
 */
export async function runReadOnly<T>(
  db: TransactionalDb,
  fn: (tx: HomeDb) => Promise<T>,
  opts: ReadOnlyOptions = {},
): Promise<T> {
  const perStatement = Math.max(100, Math.floor(opts.statementTimeoutMs ?? HOME_STATEMENT_TIMEOUT_MS));
  const budget = Math.max(perStatement, Math.floor(opts.budgetMs ?? HOME_BLOCK_BUDGET_MS));
  const deadline = performance.now() + budget;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${perStatement}`));
    const guard = (inner: HomeDb): HomeDb => ({
      execute: async (query: SQL) => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new HomeBudgetExceededError();
        // Sempre reaplica perto do fim: ROLLBACK TO SAVEPOINT desfaz um SET LOCAL anterior.
        if (remaining < perStatement) {
          await inner.execute(sql.raw(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(remaining))}`));
        }
        return inner.execute(query);
      },
      transaction: inner.transaction
        ? <R>(fn2: (sp: HomeDb) => Promise<R>): Promise<R> => inner.transaction!((sp: HomeDb) => fn2(guard(sp)))
        : undefined,
    });
    return fn(guard(tx));
  });
}

let savepointSeq = 0;

/**
 * Isola um trecho dentro da transação da home: se ele falhar, volta ao
 * SAVEPOINT e a transação continua para os trechos seguintes. Estouro do
 * prazo do bloco não é isolado (derruba o bloco inteiro como timeout).
 */
export async function withSavepoint<T>(tx: HomeDb, fn: (sp: HomeDb) => Promise<T>): Promise<T> {
  // Driver com transação aninhada (drizzle → savepoint do postgres.js): use-a; as consultas
  // do trecho PRECISAM ir pelo `sp`, senão o postgres.js guarda o erro e derruba a transação.
  if (tx.transaction) return tx.transaction((sp: HomeDb) => fn(sp));
  const name = sql.raw(`home_sp_${++savepointSeq}`);
  await tx.execute(sql`SAVEPOINT ${name}`);
  try {
    const value = await fn(tx);
    await tx.execute(sql`RELEASE SAVEPOINT ${name}`);
    return value;
  } catch (err) {
    if (err instanceof HomeBudgetExceededError) throw err;
    await tx.execute(sql`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}

export type HomeErrorCode = 'HOME_BLOCK_TIMEOUT' | 'HOME_BLOCK_UNAVAILABLE';

/** Classifica a falha de um bloco (sem expor SQL). 57014 = query_canceled (statement_timeout). */
export function classifyHomeError(err: unknown): HomeErrorCode {
  const codes: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    codes.push((cur as { code?: unknown }).code);
    cur = (cur as { cause?: unknown }).cause;
  }
  return codes.includes('57014') ? 'HOME_BLOCK_TIMEOUT' : 'HOME_BLOCK_UNAVAILABLE';
}

// ─── Loja ──────────────────────────────────────────────────────────────

export interface HomeStore {
  id: string;
  name: string;
  isActive: boolean;
  timezone: string;
  baseCurrency: string | null;
}

interface StoreRowRaw {
  id: string;
  name: string;
  is_active: boolean;
  tz: string | null;
  currency: string | null;
}

function toHomeStore(r: StoreRowRaw): HomeStore {
  return {
    id: r.id,
    name: r.name,
    isActive: Boolean(r.is_active),
    timezone: resolveTimezone(r.tz),
    baseCurrency: typeof r.currency === 'string' && r.currency.trim() ? r.currency.trim().toUpperCase() : null,
  };
}

/** Loja pelo id (validação do X-Store-Id). `null` = não existe. */
export async function findStore(db: HomeDb, storeId: string): Promise<HomeStore | null> {
  const found = await rows<StoreRowRaw>(
    db,
    sql`SELECT id, name, is_active, settings->>'timezone' AS tz, settings->>'currency' AS currency
        FROM stores WHERE id = ${storeId} LIMIT 1`,
  );
  return found[0] ? toHomeStore(found[0]) : null;
}

export async function listActiveStores(db: HomeDb): Promise<HomeStore[]> {
  const found = await rows<StoreRowRaw>(
    db,
    sql`SELECT id, name, is_active, settings->>'timezone' AS tz, settings->>'currency' AS currency
        FROM stores WHERE is_active = true ORDER BY created_at ASC, id ASC`,
  );
  return found.map(toHomeStore);
}

// ─── Períodos ──────────────────────────────────────────────────────────

export interface Periods {
  range: HomeRange;
  timezone: string;
  /** Início/fim (ISO, UTC) do período atual e do anterior equivalente. */
  current: { from: string; to: string };
  previous: { from: string; to: string };
  /** Data local (YYYY-MM-DD) do primeiro dia do período atual. */
  firstLocalDay: string;
}

function isoUtc(expr: SQL): SQL {
  return sql`to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** Calcula as janelas no fuso da loja (no banco, para acompanhar horário de verão). */
export async function resolvePeriods(db: HomeDb, range: HomeRange, timezone: string, now: Date): Promise<Periods> {
  const days = RANGE_DAYS[range];
  const back = days - 1;
  const nowIso = now.toISOString();
  const lnow = sql`(${nowIso}::timestamptz AT TIME ZONE ${timezone})`;
  const lday = sql`date_trunc('day', ${lnow})`;
  const [r] = await rows<{ cur_from: string; cur_to: string; prev_from: string; prev_to: string; first_day: string }>(
    db,
    sql`SELECT
      ${isoUtc(sql`(${lday} - make_interval(days => ${back}::int)) AT TIME ZONE ${timezone}`)} AS cur_from,
      ${isoUtc(sql`${nowIso}::timestamptz`)} AS cur_to,
      ${isoUtc(sql`(${lday} - make_interval(days => ${back + days}::int)) AT TIME ZONE ${timezone}`)} AS prev_from,
      ${isoUtc(sql`(${lnow} - make_interval(days => ${days}::int)) AT TIME ZONE ${timezone}`)} AS prev_to,
      to_char(${lday} - make_interval(days => ${back}::int), 'YYYY-MM-DD') AS first_day`,
  );
  if (!r) throw new Error('periods query returned no rows');
  return {
    range,
    timezone,
    current: { from: r.cur_from, to: r.cur_to },
    previous: { from: r.prev_from, to: r.prev_to },
    firstLocalDay: r.first_day,
  };
}

/** Chaves dos pontos do gráfico: horas (hoje) ou dias locais (7/30 dias). */
export function bucketKeys(periods: Periods): string[] {
  if (periods.range === 'today') return Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const [y, m, d] = periods.firstLocalDay.split('-').map(Number);
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return Array.from({ length: RANGE_DAYS[periods.range] }, (_, i) =>
    new Date(base + i * 86_400_000).toISOString().slice(0, 10),
  );
}

// ─── Vendas ────────────────────────────────────────────────────────────

export type SalesSourceId = 'shopify' | 'landing';

export interface CurrencyTotals {
  currency: string;
  total: number;
  orders: number;
  averageTicket: number | null;
  previousTotal: number;
  previousOrders: number;
  changePct: number | null;
}

export interface SeriesPoint {
  key: string;
  total: number;
  orders: number;
}

export interface SalesSource {
  source: SalesSourceId;
  label: string;
  currencies: CurrencyTotals[];
  /** Pedidos pagos sem valor ou sem moeda (contados, não somados). */
  withoutValue: { orders: number; previousOrders: number };
  series: Array<{ currency: string; points: SeriesPoint[] }>;
}

export interface SalesBlock {
  range: HomeRange;
  timezone: string;
  timezoneLabel: string;
  baseCurrency: string | null;
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  sources: SalesSource[];
}

const SOURCE_LABEL: Record<SalesSourceId, string> = {
  shopify: 'Pedidos da loja (Shopify)',
  landing: 'Pedidos das landings (Stripe)',
};

/** Expressões por fonte: data da venda, valor (maior unidade), filtro de pagos. */
function sourceSql(source: SalesSourceId): { table: SQL; date: SQL; paid: SQL; value: SQL; refundedMinor: SQL } {
  if (source === 'shopify') {
    return {
      table: sql`orders`,
      date: sql`COALESCE(shopify_created_at, created_at)`,
      paid: sql`financial_status IN (${list(SHOPIFY_PAID_STATUSES)})`,
      value: sql`total_price`,
      refundedMinor: sql`0`,
    };
  }
  return {
    table: sql`landing_orders`,
    date: sql`paid_at`,
    paid: sql`status IN (${list(LANDING_PAID_STATUSES)}) AND paid_at IS NOT NULL`,
    value: sql`amount`,
    refundedMinor: sql`refunded_minor`,
  };
}

interface TotalsRow {
  is_cur: boolean;
  currency: string | null;
  no_value: boolean;
  orders: number;
  gross: string | null;
  refunded_minor: string | null;
}

function netValue(source: SalesSourceId, currency: string, gross: unknown, refundedMinor: unknown): number {
  const g = num(gross);
  if (source === 'shopify') return round2(g);
  return round2(g - minorUnitsToMajor(num(refundedMinor), currency));
}

function orderCurrencies(list: CurrencyTotals[], base: string | null): CurrencyTotals[] {
  return [...list].sort((a, b) => {
    if (base && a.currency === base && b.currency !== base) return -1;
    if (base && b.currency === base && a.currency !== base) return 1;
    return b.total - a.total || a.currency.localeCompare(b.currency);
  });
}

async function salesForSource(
  db: HomeDb,
  source: SalesSourceId,
  storeId: string,
  periods: Periods,
  baseCurrency: string | null,
): Promise<SalesSource> {
  const s = sourceSql(source);
  const { current: cur, previous: prev } = periods;
  const totals = await rows<TotalsRow>(
    db,
    sql`SELECT (d >= ${cur.from}::timestamptz) AS is_cur,
               currency,
               (v IS NULL OR currency IS NULL) AS no_value,
               count(*)::int AS orders,
               sum(v)::text AS gross,
               sum(r)::text AS refunded_minor
        FROM (
          SELECT ${s.date} AS d, currency, ${s.value} AS v, ${s.refundedMinor} AS r
          FROM ${s.table}
          WHERE store_id = ${storeId} AND ${s.paid}
            AND ${s.date} >= ${prev.from}::timestamptz AND ${s.date} <= ${cur.to}::timestamptz
        ) x
        WHERE (d >= ${cur.from}::timestamptz AND d <= ${cur.to}::timestamptz)
           OR (d >= ${prev.from}::timestamptz AND d <= ${prev.to}::timestamptz)
        GROUP BY 1, 2, 3`,
  );

  const byCurrency = new Map<string, CurrencyTotals>();
  const withoutValue = { orders: 0, previousOrders: 0 };
  for (const r of totals) {
    if (r.no_value || !r.currency) {
      if (r.is_cur) withoutValue.orders += num(r.orders);
      else withoutValue.previousOrders += num(r.orders);
      continue;
    }
    const currency = r.currency.toUpperCase();
    const entry =
      byCurrency.get(currency) ??
      { currency, total: 0, orders: 0, averageTicket: null, previousTotal: 0, previousOrders: 0, changePct: null };
    const value = netValue(source, currency, r.gross, r.refunded_minor);
    if (r.is_cur) {
      entry.total = round2(entry.total + value);
      entry.orders += num(r.orders);
    } else {
      entry.previousTotal = round2(entry.previousTotal + value);
      entry.previousOrders += num(r.orders);
    }
    byCurrency.set(currency, entry);
  }
  for (const entry of byCurrency.values()) {
    entry.averageTicket = entry.orders > 0 ? round2(entry.total / entry.orders) : null;
    entry.changePct = changePct(entry.total, entry.previousTotal);
  }

  const unit = periods.range === 'today' ? 'hour' : 'day';
  const fmt = periods.range === 'today' ? 'HH24' : 'YYYY-MM-DD';
  const seriesRows = await rows<{ currency: string; bucket: string; orders: number; gross: string; refunded_minor: string }>(
    db,
    sql`SELECT currency,
               to_char(date_trunc(${unit}, ${s.date} AT TIME ZONE ${periods.timezone}), ${fmt}) AS bucket,
               count(*)::int AS orders,
               sum(${s.value})::text AS gross,
               sum(${s.refundedMinor})::text AS refunded_minor
        FROM ${s.table}
        WHERE store_id = ${storeId} AND ${s.paid}
          AND ${s.value} IS NOT NULL AND currency IS NOT NULL
          AND ${s.date} >= ${cur.from}::timestamptz AND ${s.date} <= ${cur.to}::timestamptz
        GROUP BY 1, 2`,
  );
  const keys = bucketKeys(periods);
  const series = orderCurrencies([...byCurrency.values()], baseCurrency)
    .filter((c) => c.orders > 0)
    .map((c) => {
      const points = keys.map<SeriesPoint>((key) => ({ key, total: 0, orders: 0 }));
      for (const r of seriesRows) {
        if (r.currency.toUpperCase() !== c.currency) continue;
        const point = points.find((p) => p.key === r.bucket);
        if (!point) continue;
        point.total = round2(point.total + netValue(source, c.currency, r.gross, r.refunded_minor));
        point.orders += num(r.orders);
      }
      return { currency: c.currency, points };
    });

  return {
    source,
    label: SOURCE_LABEL[source],
    currencies: orderCurrencies([...byCurrency.values()], baseCurrency),
    withoutValue,
    series,
  };
}

function sourceHasData(s: SalesSource): boolean {
  return s.currencies.length > 0 || s.withoutValue.orders > 0 || s.withoutValue.previousOrders > 0;
}

/**
 * Vendas da loja no período. Shopify sempre aparece (mesmo vazio); as
 * landings só quando há `landing_orders` com o `store_id` desta loja.
 */
export async function salesBlock(db: HomeDb, store: HomeStore, range: HomeRange, now: Date): Promise<SalesBlock> {
  const periods = await resolvePeriods(db, range, store.timezone, now);
  const shopify = await salesForSource(db, 'shopify', store.id, periods, store.baseCurrency);
  const landing = await salesForSource(db, 'landing', store.id, periods, store.baseCurrency);
  return {
    range,
    timezone: store.timezone,
    timezoneLabel: timezoneLabel(store.timezone),
    baseCurrency: store.baseCurrency,
    period: periods.current,
    previousPeriod: periods.previous,
    sources: sourceHasData(landing) ? [shopify, landing] : [shopify],
  };
}

// ─── Sessões rastreadas e conversão ───────────────────────────────────

export interface TrafficBlock {
  range: HomeRange;
  timezoneLabel: string;
  sessions: number;
  previousSessions: number;
  changePct: number | null;
  paidOrders: number;
  /** null abaixo de MIN_SESSIONS_FOR_CONVERSION sessões no período. */
  conversionPct: number | null;
  minSessions: number;
}

async function paidOrdersCount(db: HomeDb, source: SalesSourceId, storeId: string, from: string, to: string): Promise<number> {
  const s = sourceSql(source);
  const [r] = await rows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM ${s.table}
        WHERE store_id = ${storeId} AND ${s.paid}
          AND ${s.date} >= ${from}::timestamptz AND ${s.date} <= ${to}::timestamptz`,
  );
  return num(r?.n);
}

export async function trafficBlock(db: HomeDb, store: HomeStore, range: HomeRange, now: Date): Promise<TrafficBlock> {
  const periods = await resolvePeriods(db, range, store.timezone, now);
  const { current: cur, previous: prev } = periods;
  const [r] = await rows<{ cur: number; prev: number }>(
    db,
    sql`SELECT
          count(*) FILTER (WHERE created_at >= ${cur.from}::timestamptz AND created_at <= ${cur.to}::timestamptz)::int AS cur,
          count(*) FILTER (WHERE created_at >= ${prev.from}::timestamptz AND created_at <= ${prev.to}::timestamptz)::int AS prev
        FROM tracking_sessions
        WHERE store_id = ${store.id}
          AND created_at >= ${prev.from}::timestamptz AND created_at <= ${cur.to}::timestamptz`,
  );
  const sessions = num(r?.cur);
  const previousSessions = num(r?.prev);
  const paidOrders =
    (await paidOrdersCount(db, 'shopify', store.id, cur.from, cur.to)) +
    (await paidOrdersCount(db, 'landing', store.id, cur.from, cur.to));
  return {
    range,
    timezoneLabel: timezoneLabel(store.timezone),
    sessions,
    previousSessions,
    changePct: changePct(sessions, previousSessions),
    paidOrders,
    conversionPct: sessions >= MIN_SESSIONS_FOR_CONVERSION ? round2((paidOrders / sessions) * 100) : null,
    minSessions: MIN_SESSIONS_FOR_CONVERSION,
  };
}

// ─── Produtos mais vendidos ───────────────────────────────────────────

export interface TopProduct {
  key: string;
  title: string;
  quantity: number;
  orders: number;
  revenue: Array<{ currency: string; total: number }>;
}

export interface TopProductsBlock {
  range: HomeRange;
  timezoneLabel: string;
  items: TopProduct[];
}

export async function topProductsBlock(
  db: HomeDb,
  store: HomeStore,
  range: HomeRange,
  now: Date,
  limit = 5,
): Promise<TopProductsBlock> {
  const periods = await resolvePeriods(db, range, store.timezone, now);
  const s = sourceSql('shopify');
  const { current: cur } = periods;
  const found = await rows<{ key: string; title: string; quantity: number; orders: number; currency: string | null; revenue: string | null }>(
    db,
    sql`WITH items AS (
          SELECT o.id AS order_id,
                 upper(o.currency) AS currency,
                 COALESCE(NULLIF(li->>'product_id', ''), NULLIF(li->>'title', ''), 'sem-nome') AS key,
                 COALESCE(NULLIF(li->>'title', ''), 'Produto sem nome') AS title,
                 CASE WHEN (li->>'quantity') ~ '^[0-9]+$' THEN (li->>'quantity')::int ELSE 0 END AS qty,
                 CASE WHEN (li->>'price') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (li->>'price')::numeric ELSE 0 END AS price
          FROM orders o
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(o.line_items) = 'array' THEN o.line_items ELSE '[]'::jsonb END
          ) AS li
          WHERE o.store_id = ${store.id} AND ${s.paid}
            AND ${s.date} >= ${cur.from}::timestamptz AND ${s.date} <= ${cur.to}::timestamptz
        ),
        top AS (
          SELECT key, max(title) AS title, sum(qty)::int AS quantity, count(DISTINCT order_id)::int AS orders
          FROM items GROUP BY key
          HAVING sum(qty) > 0
          ORDER BY sum(qty) DESC, max(title) ASC
          LIMIT ${limit}
        )
        SELECT t.key, t.title, t.quantity, t.orders, i.currency, sum(i.price * i.qty)::text AS revenue
        FROM top t JOIN items i ON i.key = t.key
        GROUP BY t.key, t.title, t.quantity, t.orders, i.currency`,
  );
  const byKey = new Map<string, TopProduct>();
  for (const r of found) {
    const item = byKey.get(r.key) ?? { key: r.key, title: r.title, quantity: num(r.quantity), orders: num(r.orders), revenue: [] };
    if (r.currency) item.revenue.push({ currency: r.currency, total: round2(num(r.revenue)) });
    byKey.set(r.key, item);
  }
  const items = [...byKey.values()]
    .map((i) => ({ ...i, revenue: i.revenue.sort((a, b) => b.total - a.total) }))
    .sort((a, b) => b.quantity - a.quantity || a.title.localeCompare(b.title));
  return { range, timezoneLabel: timezoneLabel(store.timezone), items };
}

// ─── O que precisa de você (registro de fontes) ───────────────────────

export type AttentionSeverity = 'critical' | 'warning' | 'info';

export interface AttentionResult {
  count: number;
  oldest?: string | null;
  /** Quando há um único item com tela própria (ex.: uma disputa). */
  targetId?: string | null;
}

export interface AttentionContext {
  storeId: string;
  now: Date;
}

export interface AttentionSource {
  id: string;
  /** Id do módulo (lib/nav/modules do painel; o painel esconde se desligado). 'sistema' = sempre visível. */
  module: string;
  severity: AttentionSeverity;
  /** Em que tenants a fonte vale (ex.: domínios só existem no LandingLab). */
  appliesTo?: (storeId: string) => boolean;
  label: (count: number) => string;
  description: string;
  href: (result: AttentionResult) => string;
  run: (db: HomeDb, ctx: AttentionContext) => Promise<AttentionResult>;
}

export interface AttentionItem {
  id: string;
  module: string;
  severity: AttentionSeverity;
  label: string;
  description: string;
  count: number;
  href: string;
  oldest: string | null;
}

export interface AttentionBlock {
  items: AttentionItem[];
  /** Fontes que falharam (as demais continuam aparecendo). */
  unavailable: Array<{ id: string; label: string }>;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

async function countOldest(db: HomeDb, query: SQL): Promise<AttentionResult> {
  const [r] = await rows<{ n: number; oldest: string | null; target_id?: string | null }>(db, query);
  return { count: num(r?.n), oldest: r?.oldest ?? null, targetId: r?.target_id ?? null };
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

export const ATTENTION_SOURCES: readonly AttentionSource[] = [
  {
    id: 'disputes-due',
    module: 'atendimento',
    severity: 'critical',
    label: (n) => `${n} ${plural(n, 'disputa com prazo', 'disputas com prazo')} para responder`,
    description: 'Disputas sem defesa enviada, vencidas ou vencendo nos próximos 7 dias.',
    href: (r) => (r.count === 1 && r.targetId ? `/trustshield/disputes/${encodeURIComponent(r.targetId)}` : '/trustshield/disputes'),
    run: (db, { storeId, now }) =>
      countOldest(
        db,
        sql`SELECT count(*)::int AS n,
                   ${isoUtc(sql`min(evidence_due_by)`)} AS oldest,
                   min(id) AS target_id
            FROM disputes
            WHERE store_id = ${storeId} AND status = 'needs_response' AND evidence_sent_on IS NULL
              AND evidence_due_by IS NOT NULL
              AND evidence_due_by <= ${now.toISOString()}::timestamptz + interval '7 days'`,
      ),
  },
  {
    id: 'emails-need-reply',
    module: 'atendimento',
    severity: 'warning',
    label: (n) => `${n} ${plural(n, 'e-mail aguardando resposta', 'e-mails aguardando resposta')}`,
    description: 'Mensagens de clientes na pasta "Precisa de resposta" do Atendimento.',
    href: () => '/trustshield/inbox?folder=needs_reply',
    // Mesma regra da pasta que o link abre (lib/inbox-mail.ts, só leitura).
    run: (db, { storeId }) =>
      countOldest(
        db,
        sql`SELECT count(*)::int AS n, ${isoUtc(sql`min(e.created_at)`)} AS oldest
            FROM inbound_emails e
            LEFT JOIN inbox_email_flags f ON f.inbound_email_id = e.id
            WHERE e.store_id = ${storeId} AND ${folderCondition('needs_reply')}`,
      ),
  },
  {
    id: 'shopify-to-ship',
    module: 'pedidos',
    severity: 'warning',
    label: (n) => `${n} ${plural(n, 'pedido pago a enviar', 'pedidos pagos a enviar')}`,
    description: 'Pedidos da loja pagos e ainda sem envio.',
    href: () => '/orders',
    run: (db, { storeId }) =>
      countOldest(
        db,
        sql`SELECT count(*)::int AS n, ${isoUtc(sql`min(COALESCE(shopify_created_at, created_at))`)} AS oldest
            FROM orders
            WHERE store_id = ${storeId} AND financial_status = 'paid'
              AND (fulfillment_status IS NULL OR fulfillment_status = 'processing')`,
      ),
  },
  {
    id: 'landing-to-ship',
    module: 'landinglab',
    severity: 'warning',
    label: (n) => `${n} ${plural(n, 'pedido de landing aguardando envio', 'pedidos de landing aguardando envio')}`,
    description: 'Pedidos pagos no checkout das landings que ainda não foram enviados.',
    href: () => '/landing-orders',
    run: (db, { storeId }) =>
      countOldest(
        db,
        sql`SELECT count(*)::int AS n, ${isoUtc(sql`min(paid_at)`)} AS oldest
            FROM landing_orders
            WHERE store_id = ${storeId} AND status IN ('paid', 'preparing')`,
      ),
  },
  {
    id: 'refunds-open',
    module: 'atendimento',
    severity: 'warning',
    label: (n) => `${n} ${plural(n, 'pedido de reembolso aberto', 'pedidos de reembolso abertos')}`,
    description: 'Pedidos de reembolso esperando a sua decisão.',
    href: () => '/trustshield/refunds',
    run: (db, { storeId }) =>
      countOldest(
        db,
        sql`SELECT count(*)::int AS n, ${isoUtc(sql`min(created_at)`)} AS oldest
            FROM refund_tickets WHERE store_id = ${storeId} AND status = 'open'`,
      ),
  },
  {
    id: 'landing-support-open',
    module: 'landinglab',
    severity: 'info',
    label: (n) => `${n} ${plural(n, 'conversa de suporte aberta', 'conversas de suporte abertas')} nas landings`,
    description: 'Clientes das landings esperando resposta no suporte.',
    href: () => '/landing-support',
    run: (db, { storeId }) =>
      countOldest(
        db,
        sql`SELECT count(*)::int AS n, ${isoUtc(sql`min(created_at)`)} AS oldest
            FROM landing_support_threads WHERE store_id = ${storeId} AND status = 'open'`,
      ),
  },
  {
    id: 'domains-pending-dns',
    module: 'landinglab',
    severity: 'info',
    // Domínios não têm loja: pertencem à conta do LandingLab.
    appliesTo: (storeId) => storeId === LANDINGLAB_TENANT_ID,
    label: (n) => `${n} ${plural(n, 'domínio aguardando DNS', 'domínios aguardando DNS')}`,
    description: 'Domínios das landings que ainda não apontam para o servidor.',
    href: () => '/landing-pages/domains',
    run: (db) =>
      countOldest(
        db,
        sql`SELECT count(*)::int AS n, ${isoUtc(sql`min(created_at)`)} AS oldest
            FROM landing_domains WHERE role = 'pending_dns'`,
      ),
  },
  {
    // Story 21.5 — chip "Fora de sincronia" do Início (e item da Visão geral). Só leitura;
    // usa idx_products_sync_status (packages/db/src/schema.ts).
    id: 'products-out-of-sync',
    module: 'catalogo',
    severity: 'info',
    label: (n) => `${n} ${plural(n, 'produto fora de sincronia', 'produtos fora de sincronia')} com a Shopify`,
    description: 'Produtos com diferença entre o painel e a Shopify.',
    href: () => '/products',
    run: (db, { storeId }) =>
      countOldest(
        db,
        sql`SELECT count(*)::int AS n, NULL::text AS oldest
            FROM products
            WHERE store_id = ${storeId} AND sync_status = 'out_of_sync'`,
      ),
  },
  {
    id: 'jobs-failed',
    module: 'sistema',
    severity: 'info',
    label: (n) => `${n} ${plural(n, 'tarefa com falha', 'tarefas com falha')} nos últimos 7 dias`,
    description: 'Importações e publicações que falharam e podem ser repetidas.',
    href: () => '/jobs',
    run: (db, { storeId, now }) =>
      countOldest(
        db,
        sql`SELECT count(*)::int AS n, ${isoUtc(sql`min(updated_at)`)} AS oldest
            FROM jobs
            WHERE store_id = ${storeId} AND status = 'failed'
              AND updated_at >= ${now.toISOString()}::timestamptz - interval '7 days'`,
      ),
  },
];

/**
 * Junta as fontes de pendência dentro da MESMA transação (uma conexão do
 * pool), em série, cada fonte num SAVEPOINT: se uma falhar, ela entra em
 * `unavailable` e as outras continuam.
 */
export async function collectAttention(
  tx: HomeDb,
  ctx: AttentionContext,
  sources: readonly AttentionSource[] = ATTENTION_SOURCES,
  onError?: (sourceId: string, err: unknown) => void,
): Promise<AttentionBlock> {
  const applicable = sources.filter((s) => !s.appliesTo || s.appliesTo(ctx.storeId));
  const items: AttentionItem[] = [];
  const unavailable: AttentionBlock['unavailable'] = [];
  for (const source of applicable) {
    let result: AttentionResult;
    try {
      result = await withSavepoint(tx, (sp) => source.run(sp, ctx));
    } catch (err) {
      if (err instanceof HomeBudgetExceededError) throw err;
      onError?.(source.id, err);
      unavailable.push({ id: source.id, label: source.description });
      continue;
    }
    const { count } = result;
    if (count <= 0) continue;
    items.push({
      id: source.id,
      module: source.module,
      severity: source.severity,
      label: source.label(count),
      description: source.description,
      count,
      href: source.href(result),
      oldest: result.oldest ?? null,
    });
  }
  items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count);
  return { items, unavailable };
}

// ─── Números da loja por módulo ───────────────────────────────────────

export interface StoreModulesBlock {
  catalog: { total: number; draft: number; published: number };
  jobs: { active: number; failedLast7Days: number };
  support: { needsReply: number; refundsOpen: number; disputesOpen: number };
}

export async function storeModulesBlock(db: HomeDb, storeId: string, now: Date): Promise<StoreModulesBlock> {
  const [p] = await rows<{ total: number; draft: number; published: number }>(
    db,
    sql`SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status = 'draft')::int AS draft,
               count(*) FILTER (WHERE status = 'published')::int AS published
        FROM products WHERE store_id = ${storeId}`,
  );
  const [j] = await rows<{ active: number; failed: number }>(
    db,
    sql`SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
               count(*) FILTER (WHERE status = 'failed' AND updated_at >= ${now.toISOString()}::timestamptz - interval '7 days')::int AS failed
        FROM jobs WHERE store_id = ${storeId}`,
  );
  const [e] = await rows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM inbound_emails e
        LEFT JOIN inbox_email_flags f ON f.inbound_email_id = e.id
        WHERE e.store_id = ${storeId} AND ${folderCondition('needs_reply')}`,
  );
  const [r] = await rows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM refund_tickets WHERE store_id = ${storeId} AND status = 'open'`,
  );
  const [d] = await rows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM disputes WHERE store_id = ${storeId} AND status = 'needs_response'`,
  );
  return {
    catalog: { total: num(p?.total), draft: num(p?.draft), published: num(p?.published) },
    jobs: { active: num(j?.active), failedLast7Days: num(j?.failed) },
    support: { needsReply: num(e?.n), refundsOpen: num(r?.n), disputesOpen: num(d?.n) },
  };
}

// ─── Conta: resumo de todas as lojas ──────────────────────────────────

export interface MoneyByCurrency {
  currency: string;
  total: number;
  orders: number;
}

export interface SourcePeriodTotals {
  source: SalesSourceId;
  label: string;
  today: MoneyByCurrency[];
  last7Days: MoneyByCurrency[];
  last30Days: MoneyByCurrency[];
  /** Pedidos pagos sem valor/moeda nos últimos 30 dias. */
  withoutValue30Days: number;
}

/** Totais de hoje / 7 dias / 30 dias de uma fonte, por moeda, numa consulta só. */
export async function sourcePeriodTotals(
  db: HomeDb,
  source: SalesSourceId,
  storeId: string,
  timezone: string,
  now: Date,
): Promise<SourcePeriodTotals> {
  const s = sourceSql(source);
  const nowIso = now.toISOString();
  const lday = sql`date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${timezone})`;
  const start = (back: number): SQL => sql`((${lday} - make_interval(days => ${back}::int)) AT TIME ZONE ${timezone})`;
  const found = await rows<{
    currency: string | null;
    no_value: boolean;
    o1: number; o7: number; o30: number;
    g1: string | null; g7: string | null; g30: string | null;
    r1: string | null; r7: string | null; r30: string | null;
  }>(
    db,
    sql`SELECT currency, (v IS NULL OR currency IS NULL) AS no_value,
               count(*) FILTER (WHERE d >= ${start(0)})::int AS o1,
               count(*) FILTER (WHERE d >= ${start(6)})::int AS o7,
               count(*)::int AS o30,
               sum(v) FILTER (WHERE d >= ${start(0)})::text AS g1,
               sum(v) FILTER (WHERE d >= ${start(6)})::text AS g7,
               sum(v)::text AS g30,
               sum(r) FILTER (WHERE d >= ${start(0)})::text AS r1,
               sum(r) FILTER (WHERE d >= ${start(6)})::text AS r7,
               sum(r)::text AS r30
        FROM (
          SELECT ${s.date} AS d, currency, ${s.value} AS v, ${s.refundedMinor} AS r
          FROM ${s.table}
          WHERE store_id = ${storeId} AND ${s.paid}
            AND ${s.date} >= ${start(29)} AND ${s.date} <= ${nowIso}::timestamptz
        ) x
        GROUP BY 1, 2`,
  );
  const out: SourcePeriodTotals = {
    source,
    label: SOURCE_LABEL[source],
    today: [],
    last7Days: [],
    last30Days: [],
    withoutValue30Days: 0,
  };
  for (const r of found) {
    if (r.no_value || !r.currency) {
      out.withoutValue30Days += num(r.o30);
      continue;
    }
    const currency = r.currency.toUpperCase();
    const push = (target: MoneyByCurrency[], orders: number, gross: unknown, refunded: unknown): void => {
      if (orders <= 0) return;
      target.push({ currency, total: netValue(source, currency, gross, refunded), orders });
    };
    push(out.today, num(r.o1), r.g1, r.r1);
    push(out.last7Days, num(r.o7), r.g7, r.r7);
    push(out.last30Days, num(r.o30), r.g30, r.r30);
  }
  for (const k of ['today', 'last7Days', 'last30Days'] as const) out[k].sort((a, b) => b.total - a.total);
  return out;
}

export interface AccountStoreRow {
  id: string;
  name: string;
  /** 'store' = loja do seletor; 'landinglab' = tenant das landings (não é loja do seletor hoje). */
  kind: 'store' | 'landinglab';
  timezoneLabel: string;
  status: 'ok' | 'error';
  sources: SourcePeriodTotals[];
  /** Total de todas as fontes (o painel usa `attentionByModule` para respeitar módulos desligados). */
  attentionCount: number | null;
  /** Contagem por módulo, para o painel somar só os módulos ligados (mesma regra da Visão geral). */
  attentionByModule: Array<{ module: string; count: number }>;
  /** Alguma fonte de pendência falhou (contagem parcial). */
  attentionPartial: boolean;
}

export function attentionByModule(items: readonly AttentionItem[]): Array<{ module: string; count: number }> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item.module, (map.get(item.module) ?? 0) + item.count);
  return [...map.entries()].map(([module, count]) => ({ module, count })).sort((a, b) => a.module.localeCompare(b.module));
}

export function hasAnySales(t: SourcePeriodTotals): boolean {
  return t.last30Days.length > 0 || t.withoutValue30Days > 0;
}

// ─── Conta: blocos por módulo ─────────────────────────────────────────

export interface LandingLabBlock {
  tenantId: string;
  publishedLandings: number;
  last7Days: MoneyByCurrency[];
  openSupportThreads: number;
  attention: AttentionBlock;
}

export async function landingLabNumbers(
  db: HomeDb,
  now: Date,
): Promise<Omit<LandingLabBlock, 'attention' | 'tenantId'>> {
  const [p] = await rows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM landing_pages WHERE store_id = ${LANDINGLAB_TENANT_ID} AND status = 'published'`,
  );
  const [t] = await rows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM landing_support_threads WHERE store_id = ${LANDINGLAB_TENANT_ID} AND status = 'open'`,
  );
  const totals = await sourcePeriodTotals(db, 'landing', LANDINGLAB_TENANT_ID, DEFAULT_TIMEZONE, now);
  return { publishedLandings: num(p?.n), last7Days: totals.last7Days, openSupportThreads: num(t?.n) };
}

export interface VslBlock {
  published: number;
  draft: number;
}

export async function vslNumbers(db: HomeDb): Promise<VslBlock> {
  const [r] = await rows<{ published: number; draft: number }>(
    db,
    sql`SELECT count(*) FILTER (WHERE status = 'published')::int AS published,
               count(*) FILTER (WHERE status = 'draft')::int AS draft
        FROM vsl_projects`,
  );
  return { published: num(r?.published), draft: num(r?.draft) };
}

export interface TrackerBlock {
  enabled: boolean;
  activeCampaigns: number | null;
  clicksLast7Days: number | null;
}

/** Só SELECT agregado nas tabelas do Tracker (zona protegida). */
export async function trackerNumbers(db: HomeDb, now: Date): Promise<TrackerBlock> {
  const [c] = await rows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM tracker_campaigns WHERE status = 'active'`,
  );
  const [k] = await rows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM tracker_clicks
        WHERE created_at >= ${now.toISOString()}::timestamptz - interval '7 days'`,
  );
  return { enabled: true, activeCampaigns: num(c?.n), clicksLast7Days: num(k?.n) };
}

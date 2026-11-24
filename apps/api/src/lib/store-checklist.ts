// Story 21.4 · Checklist de loja nova — "o que falta para esta loja poder vender".
//
// SÓ LEITURA (o PUT do item manual mora na rota). Status calculado dos dados que já existem, sempre
// da loja do request (K3/K8). Duas camadas:
//   1. `collectChecklistFacts` lê o banco: uma transação somente leitura (`runReadOnly`, statement_timeout
//      3 s) com cada consulta no seu SAVEPOINT — uma consulta que falha vira fato "falhou" e só os itens
//      que dependem dela ficam `unknown` (K1). A prontidão do Atendimento (17.6d) é REUSADA:
//      `computeAtendimentoReadiness` é importada sem edição e chamada no máximo UMA vez, só com o
//      módulo `atendimento` ligado (K4).
//   2. `buildChecklistReport` (puro) transforma os fatos nos 10 itens, aplica os bloqueios por loja
//      (`store-checklist-blockers.ts`, K2) e fecha `ready`/`progress`/`nextStepId` (K5).
// Nunca lê credencial nem devolve `stores.settings`: do pixel só sai "tem/não tem chave do token" (K7).
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { computeAtendimentoReadiness, type ReadinessItem, type ReadinessReport } from './atendimento-readiness.js';
import {
  LANDING_PAID_STATUSES,
  SHOPIFY_PAID_STATUSES,
  runReadOnly,
  withSavepoint,
  type HomeDb,
  type TransactionalDb,
} from './home-blocks.js';
import { checklistBlocker, DEFAULT_STORE_ID } from './store-checklist-blockers.js';
import { getModuleStates } from './store-modules.repo.js';
import { normaliseSettings } from './store-policy-settings.js';
import { pickPublicSettings } from './store-region.js';

// ─── Contrato ─────────────────────────────────────────────────────────

export const CHECKLIST_ITEM_IDS = [
  'domain',
  'brand',
  'support_email',
  'payment',
  'shopify',
  'products',
  'pixel',
  'theme',
  'vercel',
  'test_purchase',
] as const;
export type ChecklistItemId = (typeof CHECKLIST_ITEM_IDS)[number];

export type ChecklistGroup = 'identidade' | 'atendimento' | 'vendas' | 'marketing' | 'vitrine' | 'teste';
export type ChecklistStatus = 'ok' | 'missing' | 'unknown' | 'blocked' | 'manual_done';

/** Itens que só o dono pode confirmar (lista fechada do PUT manual). */
export const MANUAL_ITEM_IDS = ['vercel'] as const;
export type ManualItemId = (typeof MANUAL_ITEM_IDS)[number];

export interface ChecklistItem {
  id: ChecklistItemId;
  group: ChecklistGroup;
  label: string;
  status: ChecklistStatus;
  blocking: boolean;
  hint: string;
  /** Tela do painel onde se resolve; `null` = sem atalho (sem tela ou tela que grava em outra loja). */
  link: string | null;
  /** Story que libera o item nesta loja (a tela mostra "Aguardando a …" e nenhum atalho). */
  blockedBy?: string;
  /** Quando o item manual foi confirmado (ISO). */
  asOf?: string;
}

export interface ChecklistReport {
  storeId: string;
  isDefault: boolean;
  generatedAt: string;
  ready: boolean;
  progress: { done: number; total: number };
  nextStepId: ChecklistItemId | null;
  items: ChecklistItem[];
}

// ─── Fatos (o que foi lido do banco) ──────────────────────────────────

export type Fact<T> = { ok: true; value: T } | { ok: false };

export interface StoreFacts {
  name: string;
  domain: string | null;
  shopifyDomain: string | null;
  /** `stores.settings` cru — só lido aqui, nunca devolvido. */
  settings: unknown;
}

export type SupportFacts = { enabled: false } | { enabled: true; report: ReadinessReport };

export interface ChecklistFacts {
  /** `null` = a loja não tem linha em `stores` (ex.: `default` sem cadastro). */
  store: Fact<StoreFacts | null>;
  products: Fact<{ published: boolean; drafts: number }>;
  /** `null` = nenhum pixel da loja. */
  pixel: Fact<{ active: boolean; hasToken: boolean } | null>;
  theme: Fact<boolean>;
  purchase: Fact<boolean>;
  support: Fact<SupportFacts>;
}

// ─── Textos e definições ──────────────────────────────────────────────

export const UNKNOWN_HINT = 'Não deu para conferir agora. Tente de novo em instantes.';
export const DEFAULT_STORE_NAME = 'Default Store';
export const ATENDIMENTO_LINK = '/trustshield/config/atendimento';
/** Sub-itens da prontidão do Atendimento que viram o item "E-mail de suporte". */
export const SUPPORT_READINESS_IDS = ['primary_address', 'sender_domain_verified', 'first_inbound_received'] as const;
/**
 * Início da dica que a prontidão do Atendimento (17.6d, só importada) devolve em `sender_domain_verified`
 * quando a loja `default` não tem remetente próprio e usa o remetente geral da conta ("Nada a conferir
 * aqui"). Não é falta de dado (K1): a loja já envia pelo remetente da conta — conta como pronto.
 * Contrato fixado por teste com a prontidão REAL (store-checklist.routes.pg.test.ts).
 */
export const ACCOUNT_SENDER_HINT_PREFIX = 'A loja padrão usa o remetente geral da conta';
export const ACCOUNT_SENDER_NOTE = 'usando o remetente geral da conta';

/** `true` só para a `default` com `sender_domain_verified` = "usa o remetente geral da conta". */
export function usesAccountSender(item: ReadinessItem, storeId: string): boolean {
  return (
    storeId === DEFAULT_STORE_ID &&
    item.id === 'sender_domain_verified' &&
    item.status === 'unknown' &&
    item.hint.startsWith(ACCOUNT_SENDER_HINT_PREFIX)
  );
}

interface ItemDef {
  group: ChecklistGroup;
  label: string;
  blocking: boolean;
  link: string | null;
}

const DEFS: Record<ChecklistItemId, ItemDef> = {
  domain: { group: 'identidade', label: 'Domínio da vitrine', blocking: true, link: '/settings/loja/endereco' },
  brand: { group: 'identidade', label: 'Marca e dados legais', blocking: true, link: '/settings/loja/politicas' },
  support_email: { group: 'atendimento', label: 'E-mail de suporte', blocking: true, link: ATENDIMENTO_LINK },
  payment: { group: 'vendas', label: 'Pagamento (gateway)', blocking: true, link: null },
  shopify: { group: 'vendas', label: 'Conexão Shopify', blocking: false, link: '/settings/loja/shopify' },
  products: { group: 'vendas', label: 'Produtos publicados', blocking: true, link: '/products' },
  pixel: { group: 'marketing', label: 'Pixel e CAPI', blocking: false, link: '/settings/loja/pixel' },
  theme: { group: 'vitrine', label: 'Vitrine (tema) pronta', blocking: true, link: '/theme' },
  vercel: { group: 'vitrine', label: 'Vitrine publicada na Vercel', blocking: true, link: null },
  test_purchase: { group: 'teste', label: 'Teste de compra', blocking: true, link: '/orders' },
};

type Partial4 = Pick<ChecklistItem, 'status' | 'hint'> & Partial<Pick<ChecklistItem, 'link' | 'blocking' | 'asOf'>>;

// ─── Regras puras ─────────────────────────────────────────────────────

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Host público de vitrine: sem protocolo, caminho, porta, espaço; não é localhost nem IP. */
export function isValidStoreHost(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!HOST_RE.test(value)) return false;
  const lower = value.toLowerCase();
  return lower !== 'localhost' && !lower.endsWith('.localhost');
}

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function shown(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

/** Data de confirmação do item manual (ISO válido) ou `null`. */
export function manualConfirmedAt(settings: unknown, itemId: ManualItemId): string | null {
  const entry = asObject(asObject(asObject(asObject(settings)['checklist'])['manual'])[itemId]);
  const at = entry['at'];
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(at) || Number.isNaN(Date.parse(at))) return null;
  return at;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function joinPt(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}

function needStore(store: StoreFacts | null): StoreFacts {
  if (!store) throw new Error('store row missing');
  return store;
}

const RULES: Record<ChecklistItemId, (f: ChecklistFacts, storeId: string) => Partial4> = {
  domain: (f) => {
    const store = needStore(value(f.store));
    const domain = store.domain ?? '';
    if (domain.trim() === '') {
      return {
        status: 'missing',
        hint: 'Esta loja não tem domínio. Cadastre o endereço da vitrine em Configurações → Endereço da loja.',
      };
    }
    if (!isValidStoreHost(domain)) {
      return {
        status: 'missing',
        hint: `O domínio cadastrado ("${shown(domain)}") não é um endereço válido: use só o host, sem https://, caminho ou espaços (ex.: minhaloja.com.br).`,
      };
    }
    return { status: 'ok', hint: `Vitrine no endereço ${domain}.` };
  },

  brand: (f, storeId) => {
    const store = needStore(value(f.store));
    const policy = normaliseSettings(asObject(store.settings));
    const name = store.name.trim();
    const missing: string[] = [];
    if (name === '' || name === DEFAULT_STORE_NAME) missing.push('nome da loja');
    if (!policy.responsibleName) missing.push('nome do responsável');
    if (!policy.contactAddress) missing.push('endereço de contato');
    if (missing.length > 0) {
      // Story 17.4e · fora da `default` o nome e os dados legais são editados na mesma tela.
      const where = storeId === DEFAULT_STORE_ID ? '' : ' Preencha em Políticas da loja → Nome da loja e dados legais.';
      return { status: 'missing', hint: `Falta: ${joinPt(missing)}.${where}` };
    }
    return { status: 'ok', hint: `${name}: responsável e endereço de contato preenchidos.` };
  },

  support_email: (f, storeId) => {
    const support = value(f.support);
    if (!support.enabled) {
      return {
        status: 'ok',
        blocking: false,
        link: null,
        hint: 'Atendimento desligado nesta loja (opcional). Ligue o módulo para receber e responder clientes por e-mail.',
      };
    }
    const subs = SUPPORT_READINESS_IDS.map((id) => support.report.items.find((i) => i.id === id));
    if (subs.some((s) => s === undefined)) return { status: 'unknown', hint: UNKNOWN_HINT };
    // R4 (decisão do lead no QA): `default` usando o remetente geral da conta conta como pronto, com
    // nota; falta real de chave do Resend (ou Resend fora) continua `unknown` e bloqueia.
    const accountSender = subs.some((s) => usesAccountSender(s!, storeId));
    const items = (subs as ReadinessItem[]).map((i) =>
      usesAccountSender(i, storeId) ? { ...i, status: 'ok' as const } : i,
    );
    const rank = { ok: 0, unknown: 1, missing: 2 } as const;
    const worst = items.reduce((acc, i) => (rank[i.status] > rank[acc] ? i.status : acc), 'ok' as ReadinessItem['status']);
    if (worst === 'ok') {
      return {
        status: 'ok',
        hint: accountSender
          ? `Endereço de suporte cadastrado e primeiro e-mail recebido; envio ${ACCOUNT_SENDER_NOTE}.`
          : 'Endereço de suporte cadastrado, domínio de envio verificado e primeiro e-mail recebido.',
        link: items[0]?.link ?? ATENDIMENTO_LINK,
      };
    }
    const pending = items.filter((i) => i.status !== 'ok');
    const first = pending.find((i) => i.blocking) ?? pending[0]!;
    return { status: worst, hint: first.hint, link: first.link ?? ATENDIMENTO_LINK };
  },

  payment: (f, storeId) => {
    const store = needStore(value(f.store));
    if (pickPublicSettings(store.settings, storeId).checkoutEnabled) {
      return { status: 'ok', hint: 'Checkout ligado nesta loja.' };
    }
    return { status: 'missing', hint: 'O checkout desta loja ainda está desligado.' };
  },

  shopify: (f) => {
    const store = needStore(value(f.store));
    const shop = (store.shopifyDomain ?? '').trim();
    if (shop) return { status: 'ok', hint: `Ligada à loja Shopify ${shown(shop)}.` };
    return { status: 'missing', hint: 'Nenhuma loja Shopify ligada (opcional: só se esta loja usar a Shopify).' };
  },

  products: (f) => {
    const p = value(f.products);
    if (p.published) return { status: 'ok', hint: 'Há produtos publicados na vitrine.' };
    if (p.drafts > 0) {
      return {
        status: 'missing',
        hint: `${plural(p.drafts, 'rascunho', 'rascunhos')}, nenhum publicado. Publique ao menos um produto.`,
      };
    }
    return { status: 'missing', hint: 'Nenhum produto nesta loja. Importe ou crie o primeiro produto.', link: '/import' };
  },

  pixel: (f) => {
    const px = value(f.pixel);
    if (!px) return { status: 'missing', hint: 'Nenhum pixel configurado nesta loja (recomendado para anúncios).' };
    if (!px.active) return { status: 'missing', hint: 'O pixel desta loja está desligado.' };
    if (!px.hasToken) return { status: 'missing', hint: 'Pixel sem token CAPI: os eventos do servidor não são enviados.' };
    return { status: 'ok', hint: 'Pixel ativo com token CAPI.' };
  },

  theme: (f) => {
    if (value(f.theme)) return { status: 'ok', hint: 'Há um tema ativo na vitrine.' };
    return { status: 'missing', hint: 'Nenhum tema ativo nesta loja. Ative um tema em Loja online.' };
  },

  vercel: (f) => {
    const store = needStore(value(f.store));
    const at = manualConfirmedAt(store.settings, 'vercel');
    if (at) {
      return { status: 'manual_done', asOf: at, hint: 'Você confirmou que o domínio já aponta para a vitrine na Vercel.' };
    }
    return {
      status: 'missing',
      hint: 'Aponte o domínio da loja para a vitrine na Vercel e confirme aqui (não dá para conferir automaticamente).',
    };
  },

  test_purchase: (f, storeId) => {
    if (value(f.purchase)) return { status: 'ok', hint: 'Já existe pedido pago ou de teste nesta loja.' };
    const store = f.store.ok ? f.store.value : null;
    const checkoutOff = storeId !== DEFAULT_STORE_ID && (!store || !pickPublicSettings(store.settings, storeId).checkoutEnabled);
    return {
      status: 'missing',
      hint: checkoutOff
        ? 'Nenhum pedido pago ainda: o checkout desta loja liga na 17.8.'
        : 'Nenhum pedido pago ainda. Faça uma compra de teste na vitrine para conferir o fluxo até o fim.',
    };
  },
};

function value<T>(fact: Fact<T>): T {
  if (!fact.ok) throw new Error('fact unavailable');
  return fact.value;
}

const DONE: ReadonlySet<ChecklistStatus> = new Set(['ok', 'manual_done']);

export function isDone(status: ChecklistStatus): boolean {
  return DONE.has(status);
}

/** Calcula um item: falha (fato indisponível, regra que lança) vira `unknown`; aplica o bloqueio da loja. */
export function buildChecklistItem(id: ChecklistItemId, facts: ChecklistFacts, storeId: string): ChecklistItem {
  const def = DEFS[id];
  let partial: Partial4;
  try {
    partial = RULES[id](facts, storeId);
  } catch {
    partial = { status: 'unknown', hint: UNKNOWN_HINT };
  }
  const item: ChecklistItem = {
    id,
    group: def.group,
    label: def.label,
    status: partial.status,
    blocking: partial.blocking ?? def.blocking,
    hint: partial.hint,
    link: partial.link === undefined ? def.link : partial.link,
  };
  if (partial.asOf) item.asOf = partial.asOf;

  const rule = checklistBlocker(id, storeId);
  if (rule && !(rule.pendingOnly && isDone(item.status))) {
    item.link = null;
    item.blockedBy = rule.blockedBy;
    if (!isDone(item.status)) {
      item.status = 'blocked';
      item.hint = rule.reason;
    }
  } else if (rule) {
    item.link = null;
  }
  return item;
}

/** Relatório completo (puro). */
export function buildChecklistReport(storeId: string, facts: ChecklistFacts, now: Date = new Date()): ChecklistReport {
  const items = CHECKLIST_ITEM_IDS.map((id) => buildChecklistItem(id, facts, storeId));
  const pendingBlocking = items.filter((i) => i.blocking && !isDone(i.status));
  return {
    storeId,
    isDefault: storeId === DEFAULT_STORE_ID,
    generatedAt: now.toISOString(),
    ready: pendingBlocking.length === 0,
    progress: { done: items.filter((i) => isDone(i.status)).length, total: items.length },
    nextStepId: pendingBlocking[0]?.id ?? null,
    items,
  };
}

// ─── Leitura do banco ─────────────────────────────────────────────────

export const CHECKLIST_STATEMENT_TIMEOUT_MS = 3_000;
export const CHECKLIST_BUDGET_MS = 3_500;
/** Teto da contagem de rascunhos (basta saber "N rascunhos"; não varre a tabela inteira). */
export const DRAFT_COUNT_CAP = 1_000;

/**
 * Dependências trocáveis nos testes (`vi.spyOn(storeChecklistDeps, …)`): a prontidão do Atendimento
 * (reuso da 17.6d, sem edição) e o relógio.
 */
export const storeChecklistDeps = {
  computeAtendimentoReadiness,
  now: (): Date => new Date(),
};

export interface StoreChecklistContext {
  db: TransactionalDb;
  storeId: string;
  vaultSecret: string;
  log?: Pick<FastifyBaseLogger, 'warn'>;
}

async function rows<T>(db: HomeDb, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = (await db.execute(query)) as unknown;
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: unknown };
  return Array.isArray(maybe.rows) ? (maybe.rows as T[]) : [];
}

function truthy(v: unknown): boolean {
  return v === true || v === 't' || v === 'true' || v === 1;
}

function list(values: readonly string[]): ReturnType<typeof sql> {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

async function loadStore(db: HomeDb, storeId: string): Promise<StoreFacts | null> {
  const [row] = await rows<{ name: string; domain: string | null; shopify_domain: string | null; settings: unknown }>(
    db,
    sql`SELECT name, domain, shopify_domain, settings FROM stores WHERE id = ${storeId} LIMIT 1`,
  );
  if (!row) return null;
  return { name: row.name ?? '', domain: row.domain, shopifyDomain: row.shopify_domain, settings: row.settings };
}

async function loadProducts(db: HomeDb, storeId: string): Promise<{ published: boolean; drafts: number }> {
  const [row] = await rows<{ published: unknown; drafts: unknown }>(
    db,
    sql`SELECT
          EXISTS (SELECT 1 FROM products WHERE store_id = ${storeId} AND status = 'published') AS published,
          (SELECT count(*) FROM (SELECT 1 FROM products WHERE store_id = ${storeId} AND status <> 'published' LIMIT ${DRAFT_COUNT_CAP}) d) AS drafts`,
  );
  return { published: truthy(row?.published), drafts: Number(row?.drafts ?? 0) || 0 };
}

async function loadPixel(db: HomeDb, storeId: string): Promise<{ active: boolean; hasToken: boolean } | null> {
  // Só "tem chave do token?" — o valor de capi_token_key nunca sai do banco (K7).
  const [row] = await rows<{ active: unknown; has_token: unknown }>(
    db,
    sql`SELECT is_active AS active, (capi_token_key IS NOT NULL AND btrim(capi_token_key) <> '') AS has_token
          FROM tracking_pixels WHERE store_id = ${storeId}
         ORDER BY is_active DESC, (capi_token_key IS NOT NULL AND btrim(capi_token_key) <> '') DESC
         LIMIT 1`,
  );
  if (!row) return null;
  return { active: truthy(row.active), hasToken: truthy(row.has_token) };
}

async function loadTheme(db: HomeDb, storeId: string): Promise<boolean> {
  const [row] = await rows<{ ok: unknown }>(
    db,
    sql`SELECT EXISTS (SELECT 1 FROM themes WHERE store_id = ${storeId} AND is_active) AS ok`,
  );
  return truthy(row?.ok);
}

async function loadShopifyPurchase(db: HomeDb, storeId: string): Promise<boolean> {
  const [row] = await rows<{ ok: unknown }>(
    db,
    sql`SELECT EXISTS (
          SELECT 1 FROM orders
           WHERE store_id = ${storeId}
             AND (financial_status IN (${list(SHOPIFY_PAID_STATUSES)})
                  OR (jsonb_typeof(raw) = 'object' AND raw->>'test' = 'true'))) AS ok`,
  );
  return truthy(row?.ok);
}

async function loadLandingPurchase(db: HomeDb, storeId: string): Promise<boolean> {
  const [row] = await rows<{ ok: unknown }>(
    db,
    sql`SELECT EXISTS (SELECT 1 FROM landing_orders WHERE store_id = ${storeId} AND status IN (${list(LANDING_PAID_STATUSES)})) AS ok`,
  );
  return truthy(row?.ok);
}

async function settle<T>(fn: () => Promise<T>): Promise<Fact<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

async function readSupport(ctx: StoreChecklistContext): Promise<Fact<SupportFacts>> {
  // Estado do módulo fora da transação (getModuleStates: "use fora de transação").
  const states = await settle(() => getModuleStates(ctx.db, ctx.storeId));
  if (!states.ok || states.value === null) return { ok: false };
  const atendimento = states.value.find((s) => s.id === 'atendimento');
  if (!atendimento) return { ok: false };
  if (!atendimento.enabled) return { ok: true, value: { enabled: false } };
  // Reuso da 17.6d: uma chamada por requisição; ela mesma nunca lança (itens viram `unknown`).
  return settle(async () => ({
    enabled: true as const,
    report: await storeChecklistDeps.computeAtendimentoReadiness({
      db: ctx.db as never,
      storeId: ctx.storeId,
      vaultSecret: ctx.vaultSecret,
      log: ctx.log,
    }),
  }));
}

/** Lê todos os fatos da loja. Só lança se a transação inteira falhar (a rota responde 503). */
export async function collectChecklistFacts(ctx: StoreChecklistContext): Promise<ChecklistFacts> {
  const { storeId } = ctx;
  const support = readSupport(ctx);
  const dbFacts = runReadOnly(
    ctx.db,
    async (tx) => {
      // Em série, cada consulta no seu SAVEPOINT: uma falha não aborta as seguintes (K1).
      const one = <T>(fn: (sp: HomeDb) => Promise<T>): Promise<Fact<T>> => settle(() => withSavepoint(tx, fn));
      const store = await one((sp) => loadStore(sp, storeId));
      const products = await one((sp) => loadProducts(sp, storeId));
      const pixel = await one((sp) => loadPixel(sp, storeId));
      const theme = await one((sp) => loadTheme(sp, storeId));
      const shopifyPaid = await one((sp) => loadShopifyPurchase(sp, storeId));
      let purchase: Fact<boolean> = shopifyPaid;
      if (!(shopifyPaid.ok && shopifyPaid.value)) {
        const landingPaid = await one((sp) => loadLandingPurchase(sp, storeId));
        purchase =
          landingPaid.ok && landingPaid.value
            ? landingPaid
            : shopifyPaid.ok && landingPaid.ok
              ? { ok: true, value: false }
              : { ok: false };
      }
      return { store, products, pixel, theme, purchase };
    },
    { statementTimeoutMs: CHECKLIST_STATEMENT_TIMEOUT_MS, budgetMs: CHECKLIST_BUDGET_MS },
  );
  const [db, supportFact] = await Promise.all([dbFacts, support]);
  return { ...db, support: supportFact };
}

/** Checklist completo da loja do contexto. */
export async function computeStoreChecklist(ctx: StoreChecklistContext): Promise<ChecklistReport> {
  const facts = await collectChecklistFacts(ctx);
  return buildChecklistReport(ctx.storeId, facts, storeChecklistDeps.now());
}

// ─── Item manual (PUT) ────────────────────────────────────────────────

export function isManualItemId(value: unknown): value is ManualItemId {
  return typeof value === 'string' && (MANUAL_ITEM_IDS as readonly string[]).includes(value);
}

export type SetManualResult =
  | { status: 'ok'; item: ChecklistItem }
  | { status: 'not_found' }
  | { status: 'invalid_settings' };

/**
 * Confirma (`done`) ou desfaz o item manual da loja em `stores.settings.checklist.manual.<item>`.
 * Um UPDATE só, atômico por linha: dois PUT simultâneos (chaves diferentes) preservam ambos — o
 * caminho `{checklist,manual}` é criado quando falta (o `create_missing` do jsonb_set só cria o
 * último nível). Desfazer usa `#-` (caminho ausente = nada muda). Settings não-objeto nunca é
 * sobrescrito (`invalid_settings`).
 */
export async function setManualChecklistItem(
  db: HomeDb,
  storeId: string,
  itemId: ManualItemId,
  done: boolean,
  now: Date = storeChecklistDeps.now(),
): Promise<SetManualResult> {
  const set = done
    ? sql`jsonb_set(
          settings,
          '{checklist}',
          (CASE WHEN jsonb_typeof(settings->'checklist') = 'object' THEN settings->'checklist' ELSE '{}'::jsonb END)
            || jsonb_build_object('manual',
                 (CASE WHEN jsonb_typeof(settings->'checklist'->'manual') = 'object' THEN settings->'checklist'->'manual' ELSE '{}'::jsonb END)
                   || jsonb_build_object(${itemId}::text, jsonb_build_object('at', ${now.toISOString()}::text))),
          true)`
    : sql`settings #- ARRAY['checklist', 'manual', ${itemId}::text]`;
  const updated = await rows<{ name: string; domain: string | null; shopify_domain: string | null; settings: unknown }>(
    db,
    sql`UPDATE stores SET settings = ${set}, updated_at = now()
         WHERE id = ${storeId} AND jsonb_typeof(settings) = 'object'
     RETURNING name, domain, shopify_domain, settings`,
  );
  const row = updated[0];
  if (!row) {
    const exists = await rows<{ id: string }>(db, sql`SELECT id FROM stores WHERE id = ${storeId} LIMIT 1`);
    return exists.length > 0 ? { status: 'invalid_settings' } : { status: 'not_found' };
  }
  const store: StoreFacts = { name: row.name ?? '', domain: row.domain, shopifyDomain: row.shopify_domain, settings: row.settings };
  const facts: ChecklistFacts = {
    store: { ok: true, value: store },
    products: { ok: false },
    pixel: { ok: false },
    theme: { ok: false },
    purchase: { ok: false },
    support: { ok: false },
  };
  return { status: 'ok', item: buildChecklistItem(itemId, facts, storeId) };
}

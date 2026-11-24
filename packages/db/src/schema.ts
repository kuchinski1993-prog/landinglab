import { sql } from 'drizzle-orm';
import {
  pgTable,
  primaryKey,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  jsonb,
  smallint,
  customType,
  uniqueIndex,
  index,
  bigserial,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

// ── Product groups (Feature B) ────────────────────────────────────────────────
// Groups sibling products split from a single source. Declared before `products`
// so the FK reference below resolves without a forward-reference lambda.

export const productGroups = pgTable(
  'product_groups',
  {
    id:        uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId:   text('store_id').notNull().default('default'),
    sourceUrl: text('source_url').notNull(),
    title:     text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceUrlIdx: uniqueIndex('idx_product_groups_source_url').on(table.storeId, table.sourceUrl),
  }),
);

export type ProductGroup    = typeof productGroups.$inferSelect;
export type NewProductGroup = typeof productGroups.$inferInsert;

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    sourceUrl: text('source_url').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description'),
    vendor: text('vendor'),
    productType: text('product_type'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    status: text('status').notNull().default('draft'),
    syncStatus: text('sync_status').notNull().default('unsynced'),
    // Story 18.3 (QA REQ-002 · 0097) · último resultado incerto na Shopify (mirror). A
    // reconciliação não recria o produto nos 2 min seguintes (indexação da busca). Limpo no publish ok.
    mirrorUncertainAt: timestamp('mirror_uncertain_at', { withTimezone: true }),
    priceBrl: numeric('price_brl', { precision: 10, scale: 2 }),
    compareAtPriceBrl: numeric('compare_at_price_brl', { precision: 10, scale: 2 }),
    buyButtonText: text('buy_button_text'),
    sellWithoutStock: boolean('sell_without_stock').notNull().default(false),
    // Story 23.3 (0107) · política de disponibilidade e prazo de produção (1–365 dias). Só vale na
    // leitura nativa de lojas ≠ 'default'; o publish Shopify continua usando sellWithoutStock.
    fulfillmentPolicy: text('fulfillment_policy').notNull().default('stock_only'),
    leadTimeDays: integer('lead_time_days'),
    slug: text('slug'),
    sizeGuide: text('size_guide'),
    showSizeTable: boolean('show_size_table').notNull().default(false),
    // Fase D — FK ao size_guides. NULL = produto sem guia (não mostra
    // link Size Guide / Find your fit no storefront, mesmo com
    // showSizeTable=true).
    sizeGuideId: uuid('size_guide_id'),
    rating: numeric('rating', { precision: 3, scale: 2 }),
    reviewCount: integer('review_count').notNull().default(0),
    // Wave 3 · ficha técnica (product-tech-sheet). Todos nullable —
    // produtos sem ficha continuam válidos. Base para o DPP europeu 2027+.
    fabricComposition: text('fabric_composition'),
    originCountry: text('origin_country'),
    manufacturingCountry: text('manufacturing_country'),
    careInstructions: text('care_instructions'),
    weightGrams: integer('weight_grams'),
    // Fase H · categoria detectada pela IA no import — controla o label
    // do campo material na UI (Composição do tecido vs Material do calçado
    // vs Material do acessório) e futura segmentação por tipo. NÃO confundir
    // com product_type (texto livre, apagado pela higiene de origem).
    // Enum de código: 'clothing' | 'footwear' | 'accessory' | 'other'.
    productCategory: text('product_category'),
    // Fase 1 · templates. NULL = usa o template padrão do tema ativo.
    // ON DELETE SET NULL: excluir template devolve o produto ao padrão.
    templateId: uuid('template_id').references(() => themeTemplates.id, {
      onDelete: 'set null',
    }),
    mirrorProductId: text('mirror_product_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    // Fase 2 · sync automático de preço multi-moeda (Frankfurter + PriceList).
    // status: 'pending' (fila/aguardando), 'synced' (OK), 'error' (erro sync).
    // error: mensagem do último erro (limpa após sucesso). synced_at: quando
    // rodou com sucesso pela última vez. Backfill: default 'pending' — não
    // presume estado histórico; primeiro sync popula.
    priceSyncStatus: text('price_sync_status').notNull().default('pending'),
    priceSyncError: text('price_sync_error'),
    priceSyncedAt: timestamp('price_synced_at', { withTimezone: true }),
    // Feature B — group membership (nullable: existing standalone products unaffected)
    groupId:       uuid('group_id').references(() => productGroups.id, { onDelete: 'set null' }),
    groupPosition: integer('group_position'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeSourceUrlIdx: uniqueIndex('idx_products_store_source_url').on(table.storeId, table.sourceUrl),
    statusIdx:     index('idx_products_status').on(table.status),
    syncStatusIdx: index('idx_products_sync_status').on(table.syncStatus),
    storeIdx:      index('idx_products_store').on(table.storeId),
    groupIdx:      index('idx_products_group').on(table.groupId),
    // Índice parcial para triagem rápida de produtos que precisam de atenção
    // (pending = ainda não sincronizado; error = último sync falhou).
    priceSyncStatusIdx: index('idx_products_price_sync_status')
      .on(table.priceSyncStatus)
      .where(sql`price_sync_status in ('pending', 'error')`),
  })
);

export const productVariants = pgTable('product_variants', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  price: text('price').notNull(),
  sku: text('sku'),
  option1: text('option1'),
  option2: text('option2'),
  option3: text('option3'),
  option1Name: text('option1_name'),
  option2Name: text('option2_name'),
  option3Name: text('option3_name'),
  mirrorVariantId: text('mirror_variant_id'),
  stock: integer('stock'),
  // Story 23.3 (0107) · prazo de produção da variante (1–365); NULL = usa o do produto.
  leadTimeDays: integer('lead_time_days'),
  locked: boolean('locked').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const productImages = pgTable('product_images', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  src: text('src').notNull(),
  alt: text('alt'),
  position: integer('position').notNull().default(0),
  isPrimary: boolean('is_primary').notNull().default(false),
  colorValue: text('color_value'),
  isPrimaryForColor: boolean('is_primary_for_color').notNull().default(false),
  localPath: text('local_path'),
  blurredPath: text('blurred_path'),
  supabasePath: text('supabase_path'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const publishRecords = pgTable('publish_records', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  storeId: text('store_id').notNull().default('default'),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  destination: text('destination').notNull(),
  shopifyProductId: text('shopify_product_id'),
  status: text('status').notNull().default('published'),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
});

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull().default('default'),
    queue: text('queue').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('waiting'),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    result: jsonb('result'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index('idx_jobs_status').on(table.status),
    queueIdx: index('idx_jobs_queue').on(table.queue),
    storeIdx: index('idx_jobs_store').on(table.storeId),
  })
);

export const jobLogs = pgTable('job_logs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  jobId: text('job_id').notNull(),
  level: text('level').notNull().default('info'),
  message: text('message').notNull(),
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const credentials = pgTable(
  'credentials',
  {
    key: text('key').primaryKey(),
    encryptedValue: bytea('encrypted_value').notNull(),
    iv: bytea('iv').notNull(),
    salt: bytea('salt').notNull(),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    testStatus: text('test_status'),
    // Canal proprietário: 'blackshop' (AuthenLondon/Shopify) | 'l0i' | 'shared'.
    // Nota: 'l0i' é identificador de dados legado — imutável (Story 13.7).
    // Default preserva comportamento pré-0046 (todas as rows antigas = 'blackshop').
    // CHECK constraint no banco valida enum. Ver migration 0046 e HLD LandingLab §16.2.
    channel: text('channel').notNull().default('blackshop'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Cobre queries do backoffice filtradas por channel (ex.: listar credenciais L0i).
    channelKeyIdx: index('idx_credentials_channel_key').on(t.channel, t.key),
  }),
);

export const priceRules = pgTable(
  'price_rules',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    sourceCurrency: text('source_currency').notNull(),
    targetCurrency: text('target_currency').notNull(),
    exchangeRate: numeric('exchange_rate', { precision: 10, scale: 6 }).notNull(),
    markupPercent: numeric('markup_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    rounding: text('rounding').notNull().default('round'),
    active: boolean('active').notNull().default(true),
    // Story 0.7 · trava manual: regra travada não recebe taxa automática do
    // refresh (a tentativa vira `skipped_locked` em fx_rate_history).
    rateLocked: boolean('rate_locked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeIdx: index('idx_price_rules_store').on(table.storeId),
  })
);

// Story 0.7 · histórico de câmbio (uma linha por tentativa de mudança por
// regra). `price_rules.exchange_rate` continua sendo a fonte do valor VIGENTE.
// origin: 'frankfurter' | 'manual' | 'bootstrap' | 'approval'
// status: 'applied' | 'pending_approval' | 'rejected' | 'invalid' |
//         'skipped_locked' | 'provider_error'
// Migration 0095 (RLS deny-all).
export const fxRateHistory = pgTable(
  'fx_rate_history',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    priceRuleId: uuid('price_rule_id').references(() => priceRules.id, { onDelete: 'set null' }),
    storeId: text('store_id').notNull().default('default'),
    sourceCurrency: text('source_currency').notNull(),
    targetCurrency: text('target_currency').notNull(),
    previousRate: numeric('previous_rate', { precision: 10, scale: 6 }),
    newRate: numeric('new_rate', { precision: 10, scale: 6 }),
    // Valor bruto recebido quando inválido (NaN, '0', 'abc', 1e9…).
    rawValue: text('raw_value'),
    changePct: numeric('change_pct', { precision: 14, scale: 4 }),
    origin: text('origin').notNull(),
    providerDate: text('provider_date'),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    storeCreatedIdx: index('idx_fx_rate_history_store_created').on(t.storeId, t.createdAt),
    ruleStatusIdx: index('idx_fx_rate_history_rule_status').on(t.priceRuleId, t.status),
  }),
);

export type FxRateHistory = typeof fxRateHistory.$inferSelect;
export type NewFxRateHistory = typeof fxRateHistory.$inferInsert;

// Story 0.7 · relatório do sync de preço em massa (limitado por execução).
// trigger: 'fx_refresh' | 'approval' | 'manual_resync' | 'dry_run'
// status:  'running' | 'completed' | 'partial' | 'failed'
// Migration 0095 (RLS deny-all).
export const fxSyncRuns = pgTable(
  'fx_sync_runs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    trigger: text('trigger').notNull(),
    status: text('status').notNull().default('running'),
    dryRun: boolean('dry_run').notNull().default(false),
    batchLimit: integer('batch_limit').notNull(),
    planned: integer('planned').notNull().default(0),
    queued: integer('queued').notNull().default(0),
    changed: integer('changed').notNull().default(0),
    unchanged: integer('unchanged').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    remaining: integer('remaining').notNull().default(0),
    // Último products.id enfileirado (ordem por id) — base do "Continuar".
    cursorProductId: uuid('cursor_product_id'),
    // Chave idempotente do pedido (índice único parcial uq_fx_sync_runs_request_key).
    requestKey: text('request_key'),
    summary: jsonb('summary').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    storeCreatedIdx: index('idx_fx_sync_runs_store_created').on(t.storeId, t.createdAt),
  }),
);

export type FxSyncRun = typeof fxSyncRuns.$inferSelect;

export const claudeCache = pgTable(
  'claude_cache',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    inputTitle: text('input_title').notNull().unique(),
    outputTitle: text('output_title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    inputIdx: uniqueIndex('idx_claude_cache_input').on(table.inputTitle),
  })
);

export const themes = pgTable(
  'themes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    tokens: jsonb('tokens').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeIdx: index('idx_themes_store').on(table.storeId),
    activeIdx: index('idx_themes_active').on(table.isActive),
  })
);

// Templates de página (modelo Shopify) — Fase 1.
// Exatamente 1 padrão por (theme_id, page) via idx_theme_templates_default
// (partial unique). Nome único por (theme_id, page) case-insensitive via
// idx_theme_templates_name.
export const themeTemplates = pgTable(
  'theme_templates',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    themeId: uuid('theme_id')
      .notNull()
      .references(() => themes.id, { onDelete: 'cascade' }),
    // Hoje só 'product'; amanhã 'collection'. CHECK constraint no banco.
    page: text('page').notNull(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    themePageIdx: index('idx_theme_templates_theme_page').on(table.themeId, table.page),
  }),
);

export type ThemeTemplate = typeof themeTemplates.$inferSelect;
export type NewThemeTemplate = typeof themeTemplates.$inferInsert;

export const themeSections = pgTable(
  'theme_sections',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    themeId: uuid('theme_id')
      .notNull()
      .references(() => themes.id, { onDelete: 'cascade' }),
    // Fase 1: template ao qual esta seção pertence. NULL para
    // page='home'/'global' (regra em código, não em banco).
    templateId: uuid('template_id').references(() => themeTemplates.id, {
      onDelete: 'cascade',
    }),
    type: text('type').notNull(),
    page: text('page').notNull().default('home'),
    position: integer('position').notNull(),
    settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
    blocks: jsonb('blocks').notNull().default(sql`'[]'::jsonb`),
    isVisible: boolean('is_visible').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    themeIdx: index('idx_theme_sections_theme').on(table.themeId),
    positionIdx: index('idx_theme_sections_position').on(table.themeId, table.position),
    templateIdx: index('idx_theme_sections_template').on(table.templateId, table.position),
  })
);

export const themeVersions = pgTable(
  'theme_versions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    themeId: uuid('theme_id').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    themeIdx: index('idx_theme_versions_theme').on(table.themeId),
  })
);

export const stores = pgTable('stores', {
  id: text('id').primaryKey().default('default'),
  name: text('name').notNull().default('Default Store'),
  domain: text('domain'),
  shopifyDomain: text('shopify_domain'),
  isActive: boolean('is_active').notNull().default(true),
  // Business identity + policy variables — 0033. Todas as chaves são
  // opcionais; ver comentário na migration para o shape esperado.
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Story 19.3a — registro de módulos por loja (migration 0096).
// Ausência de linha = ligado (padrão em @blackshop/shared/modules). Desligar só
// esconde menu/pendência da home; não bloqueia rota, fila nem tabela.
// `config` é reservado (Épico 17) e não é lido.
export const storeModules = pgTable(
  'store_modules',
  {
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    module: text('module').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.storeId, table.module], name: 'store_modules_pkey' }),
  })
);

// Story 17.6b — endereços de suporte por loja (migration 0100). O webhook de entrada decide a
// loja do e-mail pelo `to`: exato → sem `+etiqueta` → `@dominio` → nada casa = `default` + alerta.
// `pattern` é PK global (um endereço pertence a uma loja); um principal por loja (índice parcial).
export const storeSupportAddresses = pgTable(
  'store_support_addresses',
  {
    pattern: text('pattern').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    primaryUq: uniqueIndex('uq_store_support_addresses_primary')
      .on(table.storeId)
      .where(sql`${table.isPrimary}`),
    storeIdx: index('idx_store_support_addresses_store').on(table.storeId),
  })
);

export type StoreSupportAddress = typeof storeSupportAddresses.$inferSelect;
export type NewStoreSupportAddress = typeof storeSupportAddresses.$inferInsert;

// Story 19.3a — auditoria append-only de cada mudança de store_modules (C16).
export const storeModuleEvents = pgTable(
  'store_module_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    module: text('module').notNull(),
    fromEnabled: boolean('from_enabled').notNull(),
    toEnabled: boolean('to_enabled').notNull(),
    actor: text('actor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeCreatedIdx: index('idx_store_module_events_store_created').on(table.storeId, table.createdAt),
  })
);

export const trackingPixels = pgTable(
  'tracking_pixels',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    pixelId: text('pixel_id').notNull(),
    capiTokenKey: text('capi_token_key'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeIdx: index('idx_tracking_pixels_store').on(table.storeId),
    activeIdx: index('idx_tracking_pixels_active').on(table.isActive),
  })
);

export const trackingEvents = pgTable(
  'tracking_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    eventName: text('event_name').notNull(),
    eventId: text('event_id').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull().default('sent'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeIdx: index('idx_tracking_events_store').on(table.storeId),
    eventNameIdx: index('idx_tracking_events_event_name').on(table.eventName),
    eventIdIdx: index('idx_tracking_events_event_id').on(table.eventId),
  })
);

// Tracking Fase 2 — visitas de atribuição (first-touch) persistidas a partir do
// bs_attribution capturado no navegador. ip/userAgent/country ficam preparados
// para o ambiente do PC; no notebook chegam NULL.
export const trackingSessions = pgTable(
  'tracking_sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    fbclid: text('fbclid'),
    fbp: text('fbp'),
    fbc: text('fbc'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    utmTerm: text('utm_term'),
    landingUrl: text('landing_url'),
    referrer: text('referrer'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    country: text('country'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    fbcIdx: index('idx_tracking_sessions_fbc').on(table.fbc),
    fbclidIdx: index('idx_tracking_sessions_fbclid').on(table.fbclid),
    createdIdx: index('idx_tracking_sessions_created').on(table.createdAt),
  })
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ProductVariant = typeof productVariants.$inferSelect;
export type NewProductVariant = typeof productVariants.$inferInsert;
export type ProductImage = typeof productImages.$inferSelect;
export type NewProductImage = typeof productImages.$inferInsert;
export type PublishRecord = typeof publishRecords.$inferSelect;
export type NewPublishRecord = typeof publishRecords.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobLog = typeof jobLogs.$inferSelect;
export type NewJobLog = typeof jobLogs.$inferInsert;
export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;
export type PriceRule = typeof priceRules.$inferSelect;
export type NewPriceRule = typeof priceRules.$inferInsert;
export type ClaudeCache = typeof claudeCache.$inferSelect;
export type NewClaudeCache = typeof claudeCache.$inferInsert;
export type Theme = typeof themes.$inferSelect;
export type NewTheme = typeof themes.$inferInsert;
export type ThemeSection = typeof themeSections.$inferSelect;
export type NewThemeSection = typeof themeSections.$inferInsert;
export type ThemeVersion = typeof themeVersions.$inferSelect;
export type NewThemeVersion = typeof themeVersions.$inferInsert;
export type Store = typeof stores.$inferSelect;
export type NewStore = typeof stores.$inferInsert;
export type TrackingPixel = typeof trackingPixels.$inferSelect;
export type NewTrackingPixel = typeof trackingPixels.$inferInsert;
export type TrackingEvent = typeof trackingEvents.$inferSelect;
export type NewTrackingEvent = typeof trackingEvents.$inferInsert;
export type TrackingSession = typeof trackingSessions.$inferSelect;
export type NewTrackingSession = typeof trackingSessions.$inferInsert;

// Fase Popup · leads capturados pelo pop-up de desconto (e outros
// pontos de captura no futuro — source discrimina origem). Nós
// GRAVAMOS o lead sempre (base legal: entregar o cupom que o cliente
// pediu — soft opt-in do UK GDPR); o envio ao Meta como evento Lead
// é gateado por consent_marketing (respeita o banner bs_consent).
//
// UNIQUE (store_id, email) é o alvo do UPSERT: segunda submissão do
// mesmo email atualiza phone/consent/coupon sem duplicar linha.
export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    email: text('email').notNull(),
    phone: text('phone'),
    consentMarketing: boolean('consent_marketing').notNull().default(false),
    couponShown: text('coupon_shown'),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeEmailUniq: uniqueIndex('idx_leads_store_email').on(table.storeId, table.email),
    createdIdx: index('idx_leads_created').on(table.createdAt),
  }),
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;

// ── Collections ───────────────────────────────────────────────────────────────

export const collections = pgTable(
  'collections',
  {
    id:          uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId:     text('store_id').notNull().default('default'),
    name:        text('name').notNull(),
    slug:        text('slug').notNull(),
    description: text('description'),
    imageUrl:    text('image_url'),
    sortOrder:   text('sort_order').notNull().default('manual'),
    isActive:    boolean('is_active').notNull().default(true),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugIdx:  uniqueIndex('idx_collections_slug').on(table.storeId, table.slug),
    storeIdx: index('idx_collections_store').on(table.storeId),
  }),
);

export const collectionProducts = pgTable(
  'collection_products',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    addedAt:  timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk:         primaryKey({ columns: [table.collectionId, table.productId] }),
    productIdx: index('idx_cp_product').on(table.productId),
  }),
);

export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type CollectionProduct = typeof collectionProducts.$inferSelect;
export type NewCollectionProduct = typeof collectionProducts.$inferInsert;

// ── Product pairings (Wave 2 · product-pair-well-with) ────────────────────────
// Curadoria manual do bloco "Combina bem com". Diferente de product-related
// (algorítmico) — esta é editorial: o dono seleciona as peças no backoffice.

export const productPairings = pgTable(
  'product_pairings',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    pairedProductId: uuid('paired_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk:         primaryKey({ columns: [table.productId, table.pairedProductId] }),
    productIdx: index('idx_product_pairings_product').on(table.productId, table.position),
  }),
);

export type ProductPairing = typeof productPairings.$inferSelect;
export type NewProductPairing = typeof productPairings.$inferInsert;

// ── Factory Jobs ──────────────────────────────────────────────────────────────

export const factoryJobs = pgTable(
  'factory_jobs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull(),
    ownerEmail: text('owner_email').notNull(),
    status: text('status').notNull().default('pending'),
    brief: jsonb('brief').notNull().default(sql`'{}'::jsonb`),
    brandResult: jsonb('brand_result'),
    domainResult: jsonb('domain_result'),
    shopifyResult: jsonb('shopify_result'),
    completedSteps: text('completed_steps').array().notNull().default(sql`'{}'::text[]`),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeIdx: index('idx_factory_jobs_store').on(table.storeId),
    statusIdx: index('idx_factory_jobs_status').on(table.status),
    createdIdx: index('idx_factory_jobs_created').on(table.createdAt),
  })
);

export type FactoryJob = typeof factoryJobs.$inferSelect;
export type NewFactoryJob = typeof factoryJobs.$inferInsert;

export const refundTickets = pgTable(
  'refund_tickets',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull(),
    orderId: text('order_id').notNull(),
    customerEmail: text('customer_email').notNull(),
    status: text('status').notNull().default('open'),
    reasonCategory: text('reason_category'),
    aiRecommendation: text('ai_recommendation'),
    aiConfidence: numeric('ai_confidence', { precision: 4, scale: 3 }),
    // TrustShield Fase B2 — classificação de intenção da última mensagem do
    // cliente. provider = 'mock' | 'anthropic:<modelo>'. analyzed_at marca
    // quando o classify rodou (auditoria + permitir re-rodar sob demanda).
    aiIntent: text('ai_intent'),
    aiIntentConfidence: numeric('ai_intent_confidence', { precision: 4, scale: 3 }),
    aiProvider: text('ai_provider'),
    aiAnalyzedAt: timestamp('ai_analyzed_at', { withTimezone: true }),
    // Fase C: saída rica do recommendRefund. ai_reasoning é INTERNO —
    // o GET público em refunds.routes.ts filtra ai_* fora do payload.
    aiSignals: jsonb('ai_signals'),
    aiReasoning: text('ai_reasoning'),
    // Origem do ticket: 'storefront_form' (portal, default retro-compat)
    // ou 'inbound_email' (aberto automaticamente pelo pipeline TrustShield
    // quando category=refund_request). Nullable para linhas antigas.
    source: text('source'),
    // Rastreabilidade: quando source='inbound_email', referencia o email
    // que abriu o ticket. Nullable. Sem FK "hard" pra evitar cascade
    // acoplamento entre pipelines (soft ref).
    sourceInboundEmailId: uuid('source_inbound_email_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeIdx: index('idx_refund_tickets_store').on(table.storeId),
    statusIdx: index('idx_refund_tickets_status').on(table.status),
    createdIdx: index('idx_refund_tickets_created').on(table.createdAt),
    aiIntentIdx: index('idx_refund_tickets_ai_intent').on(table.aiIntent),
    sourceInboundIdx: index('idx_refund_tickets_source_inbound').on(table.sourceInboundEmailId),
  })
);

export const refundMessages = pgTable(
  'refund_messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => refundTickets.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ticketIdx: index('idx_refund_messages_ticket').on(table.ticketId),
    createdIdx: index('idx_refund_messages_created').on(table.createdAt),
  })
);

export type RefundTicket = typeof refundTickets.$inferSelect;
export type NewRefundTicket = typeof refundTickets.$inferInsert;
export type RefundMessage = typeof refundMessages.$inferSelect;
export type NewRefundMessage = typeof refundMessages.$inferInsert;

// ── Email templates (TrustShield Fase 8) ───────────────────────────────────────
// One row per (store_id, event_key). CRUD only — sending depends on an email
// provider not wired yet. Upsert key is the unique (store_id, event_key) index.
export const emailTemplates = pgTable(
  'email_templates',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    eventKey: text('event_key').notNull(),
    subject: text('subject').notNull(),
    htmlBody: text('html_body').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeEventIdx: uniqueIndex('idx_email_templates_store_event').on(table.storeId, table.eventKey),
    storeIdx: index('idx_email_templates_store').on(table.storeId),
  })
);

export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type NewEmailTemplate = typeof emailTemplates.$inferInsert;

// ── Orders (TrustShield Fase B1) ──────────────────────────────────────────────
// Pedidos pagos da Shopify, persistidos pelo webhook ORDERS_PAID. Idempotente
// por id (id do pedido na Shopify, como texto). `raw` guarda o payload original
// para não perder campos não desnormalizados. customerEmail/Phone em claro:
// uso interno apenas — nenhum endpoint público expõe esta tabela.
export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull().default('default'),
    orderNumber: text('order_number'),
    totalPrice: numeric('total_price', { precision: 12, scale: 2 }),
    currency: text('currency'),
    customerEmail: text('customer_email'),
    customerPhone: text('customer_phone'),
    financialStatus: text('financial_status'),
    lineItems: jsonb('line_items').notNull().default(sql`'[]'::jsonb`),
    raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
    // Portal Fase 2 — fulfillment estrutural. Antes vivia só em raw;
    // agora colunas próprias para query rápida no Track Order.
    // Valores esperados: 'processing' | 'fulfilled' | 'shipped' |
    // 'delivered' | null (schema não força enum para permitir extensão
    // conforme a Shopify introduzir estados novos).
    fulfillmentStatus: text('fulfillment_status'),
    carrier: text('carrier'),
    trackingNumber: text('tracking_number'),
    shopifyCreatedAt: timestamp('shopify_created_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeIdx: index('idx_orders_store').on(table.storeId),
    emailIdx: index('idx_orders_customer_email').on(table.customerEmail),
    shopifyCreatedIdx: index('idx_orders_shopify_created').on(table.shopifyCreatedAt),
    trackingIdx: index('idx_orders_tracking_number').on(
      table.storeId,
      table.trackingNumber,
    ),
  }),
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

// ── Tentativas de entrega do webhook Shopify (Story 0.2) — 0094 ───────────
//
// Uma linha por (X-Shopify-Webhook-Id, tópico). status: 'failed' (pedido não
// gravado, API respondeu 503), 'tracking_pending' (pedido gravado, tracking/CAPI
// pendente) ou 'processed'. last_error nunca contém e-mail/telefone.
// A 0094 também cria o índice único parcial uq_tracking_events_purchase_event_id
// em tracking_events (event_name, event_id) WHERE event_name = 'Purchase' —
// condicional (só sem duplicatas), por isso não está declarado em trackingEvents.
export const webhookDeliveryAttempts = pgTable(
  'webhook_delivery_attempts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    webhookId: text('webhook_id').notNull(),
    topic: text('topic').notNull(),
    orderId: text('order_id'),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(1),
    errorCode: text('error_code'),
    lastError: text('last_error'),
    firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    webhookTopicUq: uniqueIndex('uq_webhook_delivery_attempts_webhook_topic').on(t.webhookId, t.topic),
    orderIdx: index('idx_webhook_delivery_attempts_order').on(t.orderId),
    pendingIdx: index('idx_webhook_delivery_attempts_pending')
      .on(t.status, t.lastAttemptAt)
      .where(sql`${t.status} IN ('failed', 'tracking_pending')`),
    // CHECK (status IN ('failed','tracking_pending','processed')) vive na 0094.
  }),
);

export type WebhookDeliveryAttempt = typeof webhookDeliveryAttempts.$inferSelect;

// ── Ledger de jobs duráveis (Story 18.3 · migration 0097) ──────────────
//
// Uma linha por (queue, job_key) dos jobs que adotaram @blackshop/jobs. O BullMQ
// segue como motor; aqui fica o desfecho (tentativas, lease com fencing, error_code).
// CHECKs de state/error_kind vivem na 0097. RLS habilitado sem policies.
export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    queue: text('queue').notNull(),
    jobKey: text('job_key').notNull(),
    jobName: text('job_name'),
    // queued | queued_failed | running | retrying | succeeded | failed | uncertain | lost
    state: text('state').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(1),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    // deterministic | transient | uncertain
    errorKind: text('error_kind'),
    errorCode: text('error_code'),
    lastError: text('last_error'),
    // Reservado para a story 18.4.
    correlationId: text('correlation_id'),
    result: jsonb('result'),
    // Flags mínimas para o reconcile reconstruir o job (nunca dados do cliente).
    replay: jsonb('replay'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    queueJobKeyUq: uniqueIndex('uq_job_runs_queue_job_key').on(t.queue, t.jobKey),
    stateLeaseIdx: index('idx_job_runs_state_lease').on(t.state, t.leaseUntil),
    queueStateIdx: index('idx_job_runs_queue_state').on(t.queue, t.state),
  }),
);

export type JobRunRow = typeof jobRuns.$inferSelect;

// ── Shipment events (Portal Fase 2) ────────────────────────────────────
//
// Feed do timeline do Track Order. Cada evento reportado pelo webhook
// Shopify (orders/updated, fulfillments/updated) vira uma linha. Portal
// renderiza cronologicamente. Idempotência via unique index parcial em
// (store_id, order_id, event_at, status) — reenvio do webhook é NO-OP.
export const shipmentEvents = pgTable(
  'shipment_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    orderId: text('order_id').notNull(),
    status: text('status'),
    description: text('description'),
    location: text('location'),
    eventAt: timestamp('event_at', { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    feedIdx: index('idx_shipment_events_feed').on(t.storeId, t.orderId, t.eventAt),
  }),
);

export type ShipmentEvent = typeof shipmentEvents.$inferSelect;
export type NewShipmentEvent = typeof shipmentEvents.$inferInsert;

// ── Disputes (Shopify Payments chargebacks/inquiries) — 0032 ──────────────
//
// Guarda a disputa REAL reportada pela Shopify via webhooks
// `disputes/create` + `disputes/update`. Diferente do `chargeback_threat`
// classificado em e-mails (pré-chargeback), este é o pós-chargeback.
//
// Régua: sistema PREPARA a evidência (evidence_draft, editável pelo dono);
// submissão só via endpoint dedicado após aprovação explícita. NUNCA
// auto-submit. evidence_sent_on + evidence_submitted_by são a auditoria.
export const disputes = pgTable(
  'disputes',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull().default('default'),
    orderId: text('order_id'),
    type: text('type'),
    amount: numeric('amount', { precision: 12, scale: 2 }),
    currency: text('currency'),
    reason: text('reason'),
    networkReasonCode: text('network_reason_code'),
    status: text('status').notNull().default('needs_response'),
    evidenceDueBy: timestamp('evidence_due_by', { withTimezone: true }),
    evidenceSentOn: timestamp('evidence_sent_on', { withTimezone: true }),
    finalizedOn: timestamp('finalized_on', { withTimezone: true }),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }),
    // Rascunho de evidência editado pelo dono antes do submit. jsonb para
    // acomodar todos os campos que a Shopify aceita sem migration por
    // campo. Ver formato no comentário da migration 0032.
    evidenceDraft: jsonb('evidence_draft'),
    evidenceSubmittedBy: text('evidence_submitted_by'),
    raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('idx_disputes_store_status').on(t.storeId, t.status),
    orderIdx: index('idx_disputes_store_order').on(t.storeId, t.orderId),
    dueByIdx: index('idx_disputes_due_by').on(t.evidenceDueBy),
  }),
);

export type Dispute = typeof disputes.$inferSelect;
export type NewDispute = typeof disputes.$inferInsert;

// ── Size Guides (Fase D) ─────────────────────────────────────────────────
//
// Guias reutilizáveis criados pelo dono (nome livre). Cada produto pode
// referenciar UM via products.size_guide_id (FK opcional). Formato do
// `table` documentado na migration 0034.
export const sizeGuides = pgTable(
  'size_guides',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    name: text('name').notNull(),
    notes: text('notes'),
    table: jsonb('table').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    storeIdx: index('idx_size_guides_store').on(t.storeId),
  }),
);

export type SizeGuide = typeof sizeGuides.$inferSelect;
export type NewSizeGuide = typeof sizeGuides.$inferInsert;

// ── Campos personalizados de produto por loja (Story 23.4 — migration 0108) ─────
// Definição por loja (5 tipos fechados) + valor por produto × definição (texto validado por tipo
// na API). `product_custom_values` não tem store_id: a API confere produto E definição da loja.

export const storeCustomFields = pgTable(
  'store_custom_fields',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type').notNull(),
    options: jsonb('options').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    isPublic: boolean('is_public').notNull().default(true),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    storeKeyUnique: uniqueIndex('store_custom_fields_store_key_unique').on(t.storeId, t.key),
    storePositionIdx: index('idx_store_custom_fields_store_position').on(t.storeId, t.position),
  }),
);

export type StoreCustomField = typeof storeCustomFields.$inferSelect;
export type NewStoreCustomField = typeof storeCustomFields.$inferInsert;

export const productCustomValues = pgTable(
  'product_custom_values',
  {
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id').notNull().references(() => storeCustomFields.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.productId, t.fieldId] }),
    fieldIdx: index('idx_product_custom_values_field').on(t.fieldId),
  }),
);

export type ProductCustomValue = typeof productCustomValues.$inferSelect;

// ── Pages (mini-CMS) ──────────────────────────────────────────────────────────

export const pages = pgTable(
  'pages',
  {
    id:             uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId:        text('store_id').notNull().default('default'),
    title:          text('title').notNull(),
    slug:           text('slug').notNull(),
    content:        text('content').notNull().default(''),
    status:         text('status').notNull().default('draft'),
    seoTitle:       text('seo_title'),
    seoDescription: text('seo_description'),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugIdx:   uniqueIndex('idx_pages_slug').on(table.storeId, table.slug),
    storeIdx:  index('idx_pages_store').on(table.storeId),
    statusIdx: index('idx_pages_status').on(table.status),
  })
);

export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;

// ── Avaliações de produtos ────────────────────────────────────────────────────

export const productReviews = pgTable(
  'product_reviews',
  {
    id:         uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId:    text('store_id').notNull().default('default'),
    productId:  uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    authorName: text('author_name').notNull(),
    rating:     integer('rating').notNull(),
    title:      text('title'),
    comment:    text('comment').notNull(),
    status:     text('status').notNull().default('pending'),
    source:     text('source').notNull().default('manual'),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productIdx: index('idx_product_reviews_product').on(t.productId, t.status),
    storeIdx:   index('idx_product_reviews_store').on(t.storeId, t.status),
  }),
);

export type ProductReview = typeof productReviews.$inferSelect;
export type NewProductReview = typeof productReviews.$inferInsert;

// ── Perguntas e Respostas ─────────────────────────────────────────────────────

export const productQuestions = pgTable(
  'product_questions',
  {
    id:         uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId:    text('store_id').notNull().default('default'),
    productId:  uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    authorName: text('author_name').notNull(),
    question:   text('question').notNull(),
    answer:     text('answer'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    status:     text('status').notNull().default('pending'),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productIdx: index('idx_product_questions_product').on(t.productId, t.status),
    storeIdx:   index('idx_product_questions_store').on(t.storeId, t.status),
  }),
);

export type ProductQuestion = typeof productQuestions.$inferSelect;
export type NewProductQuestion = typeof productQuestions.$inferInsert;

// ── Inbound emails (TrustShield Fase 3) ───────────────────────────────────────
// Persiste emails enviados a support@authenlondon.com (e aliases) recebidos via
// Cloudflare Email Routing → Email Worker → POST /webhooks/email/inbound.
//
// Esta fase é APENAS de captura: nenhuma classificação/resposta automática.
// `status` começa sempre em 'received' — Fase 4 (IA classifica) e Fase 5 (IA
// responde via Resend) avançarão os estados para 'classified' / 'answered' /
// 'ignored'. Mantemos o ciclo de vida explícito desde já para não precisar
// migrar a tabela depois.
//
// Idempotência: `message_id` (RFC 5322 Message-ID) é único quando presente.
// Cloudflare reentrega; sem o index único, atacante poderia reenviar o mesmo
// header para forjar duplicidade. Index parcial (WHERE message_id IS NOT NULL)
// porque o Worker pode não conseguir extrair o Message-ID em todos os casos.
//
// PII: from/to/subject/text_body/html_body são dados de cliente. NUNCA logar
// crus. O conteúdo é gravado em jsonb (`raw`) como fonte da verdade.
export const inboundEmails = pgTable(
  'inbound_emails',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    messageId: text('message_id'),
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name'),
    toAddress: text('to_address').notNull(),
    subject: text('subject'),
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    headers: jsonb('headers'),
    raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
    spfResult: text('spf_result'),
    dkimResult: text('dkim_result'),
    // Ciclo de vida (Fase 4+5): received → classified →
    //   answered_auto | answered_human | awaiting_customer |
    //   pending_human | converted_to_refund |
    //   spam_auto | spam_confirmed | auto_filtered | auto_quarantined |
    //   resolved.
    status: text('status').notNull().default('received'),
    // Classificação (Fase 4).
    category: text('category'),
    classificationConfidence: numeric('classification_confidence', { precision: 4, scale: 3 }),
    classificationSignals: jsonb('classification_signals'),
    aiProvider: text('ai_provider'),
    // Identidade do remetente (Fase 4):
    //   verified_match | verified_via_order | unknown_sender | suspicious_claim
    verificationState: text('verification_state'),
    threadId: uuid('thread_id'),
    orderId: text('order_id'),
    refundTicketId: uuid('refund_ticket_id'),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    // Timestamp do acuse-recebimento (ack determinístico enviado ao
    // cliente). Lock lógico de idempotência: só enfileira ack se este
    // campo for null. Preenchido pelo processor após enqueue bem-sucedido.
    acknowledgementSentAt: timestamp('acknowledgement_sent_at', { withTimezone: true }),
    // Heurística que pulou IA (auto-submitted, bot_noreply, ...).
    prefilterReason: text('prefilter_reason'),
    // Ação proposta pelo pipeline (mesmo em shadow mode).
    proposedAction: text('proposed_action'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    storeCreatedIdx: index('idx_inbound_emails_store_created').on(t.storeId, t.createdAt),
    statusCategoryIdx: index('idx_inbound_emails_status_category').on(
      t.storeId, t.status, t.category, t.createdAt,
    ),
    threadIdx: index('idx_inbound_emails_thread').on(t.threadId, t.createdAt),
    fromIdx: index('idx_inbound_emails_from').on(t.storeId, t.fromAddress),
    // Dedupe por Message-ID (parcial: só quando presente). Drizzle gera DDL
    // sem cláusula WHERE; o índice é criado na migration com o WHERE manual.
    // Story 17.6a (0099): único POR LOJA — o mesmo Message-ID pode existir em duas lojas.
    messageIdIdx: uniqueIndex('idx_inbound_emails_store_message_id').on(t.storeId, t.messageId),
  }),
);

export type InboundEmail = typeof inboundEmails.$inferSelect;
export type NewInboundEmail = typeof inboundEmails.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// inbox_email_flags — Story 16.1 (migration 0091)
// ─────────────────────────────────────────────────────────────────────────────
//
// Estado de organização da Caixa de entrada (lido, estrela, arquivado), estilo
// Gmail. Separado de inbound_emails para não tocar no ciclo de vida do
// pipeline. Sem linha = não lido, sem estrela, não arquivado.
export const inboxEmailFlags = pgTable('inbox_email_flags', {
  inboundEmailId: uuid('inbound_email_id')
    .primaryKey()
    .references(() => inboundEmails.id, { onDelete: 'cascade' }),
  storeId: text('store_id').notNull(),
  readAt: timestamp('read_at', { withTimezone: true }),
  starred: boolean('starred').notNull().default(false),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type InboxEmailFlags = typeof inboxEmailFlags.$inferSelect;

// ── Inbound AI pipeline (TrustShield Fase 4+5) ────────────────────────────────

export const conversationThreads = pgTable(
  'conversation_threads',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    customerEmail: text('customer_email').notNull(),
    orderId: text('order_id'),
    verificationState: text('verification_state').notNull().default('unknown_sender'),
    // open | awaiting_customer | resolved | abandoned
    status: text('status').notNull().default('open'),
    category: text('category'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({
    emailIdx: index('idx_threads_email').on(t.storeId, t.customerEmail),
    statusIdx: index('idx_threads_status').on(t.storeId, t.status, t.updatedAt),
  }),
);

export type ConversationThread = typeof conversationThreads.$inferSelect;
export type NewConversationThread = typeof conversationThreads.$inferInsert;

export const inboundEmailDrafts = pgTable(
  'inbound_email_drafts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    inboundEmailId: uuid('inbound_email_id').notNull().references(() => inboundEmails.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    htmlBody: text('html_body').notNull(),
    textBody: text('text_body'),
    guardPassed: boolean('guard_passed').notNull().default(true),
    guardReasons: jsonb('guard_reasons'),
    aiProvider: text('ai_provider'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    edited: boolean('edited').notNull().default(false),
  },
  (t) => ({
    inboundIdx: index('idx_drafts_inbound').on(t.inboundEmailId, t.createdAt),
  }),
);

export type InboundEmailDraft = typeof inboundEmailDrafts.$inferSelect;
export type NewInboundEmailDraft = typeof inboundEmailDrafts.$inferInsert;

export const inboundClassificationFeedback = pgTable(
  'inbound_classification_feedback',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    inboundEmailId: uuid('inbound_email_id').notNull().references(() => inboundEmails.id, { onDelete: 'cascade' }),
    aiCategory: text('ai_category'),
    aiConfidence: numeric('ai_confidence', { precision: 4, scale: 3 }),
    operatorCategory: text('operator_category').notNull(),
    // reclassify | spam_false_positive | draft_edit | draft_reject
    feedbackType: text('feedback_type').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index('idx_feedback_created').on(t.createdAt),
    typeIdx: index('idx_feedback_type').on(t.feedbackType, t.createdAt),
  }),
);

export type InboundClassificationFeedback = typeof inboundClassificationFeedback.$inferSelect;
export type NewInboundClassificationFeedback = typeof inboundClassificationFeedback.$inferInsert;

export const inboundAiActions = pgTable(
  'inbound_ai_actions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    inboundEmailId: uuid('inbound_email_id').notNull().references(() => inboundEmails.id, { onDelete: 'cascade' }),
    // classify | draft_reply | extract_order_number
    functionName: text('function_name').notNull(),
    // mock | anthropic:claude-haiku-4-5-20251001
    provider: text('provider').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    succeeded: boolean('succeeded').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    functionIdx: index('idx_ai_actions_function').on(t.functionName, t.createdAt),
    providerIdx: index('idx_ai_actions_provider_created').on(t.provider, t.createdAt),
  }),
);

export type InboundAiAction = typeof inboundAiActions.$inferSelect;
export type NewInboundAiAction = typeof inboundAiActions.$inferInsert;

export const inboundAutomationConfig = pgTable('inbound_automation_config', {
  storeId: text('store_id').primaryKey(),
  autoReplyConfidence: numeric('auto_reply_confidence', { precision: 4, scale: 3 })
    .notNull()
    .default('0.85'),
  spamConfidence: numeric('spam_confidence', { precision: 4, scale: 3 })
    .notNull()
    .default('0.85'),
  // Começa DESLIGADO: modo shadow. Dono liga depois de validar precisão.
  automationEnabled: boolean('automation_enabled').notNull().default(false),
  autoReplyCategories: text('auto_reply_categories')
    .array()
    .notNull()
    .default(sql`ARRAY['policy_question', 'product_question_pre_purchase']::text[]`),
  dailyCostAlertUsd: numeric('daily_cost_alert_usd', { precision: 8, scale: 2 }),
  // EXCEÇÃO ao shadow mode: o acuse-recebimento (ack determinístico, não
  // decide dinheiro) é enviado mesmo com automation_enabled=false.
  // Régua: comunicação segura (nunca prometemos $), o silêncio é o que
  // gera chargeback. Dono pode desligar via este flag se realmente
  // precisar (raro; deixe true).
  acknowledgementAlwaysOn: boolean('acknowledgement_always_on').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type InboundAutomationConfig = typeof inboundAutomationConfig.$inferSelect;
export type NewInboundAutomationConfig = typeof inboundAutomationConfig.$inferInsert;

export const inboundAttachments = pgTable(
  'inbound_attachments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    inboundEmailId: uuid('inbound_email_id').notNull().references(() => inboundEmails.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    // Path no bucket Supabase Storage "inbound-attachments".
    storageKey: text('storage_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    inboundIdx: index('idx_attachments_inbound').on(t.inboundEmailId, t.createdAt),
  }),
);

export type InboundAttachment = typeof inboundAttachments.$inferSelect;
export type NewInboundAttachment = typeof inboundAttachments.$inferInsert;

// ── Customer notes (Fase 2 — TrustShield contexto do cliente) ────────────
//
// Notas persistentes que o dono/operador anota sobre um cliente. Agrupadas
// por email NORMALIZADO (packages/shared/src/inbound/normalize-email.ts) para
// juntar variantes do mesmo cliente (Gmail dot/plus). Nunca visíveis ao
// cliente — uso interno. Preservam o email original em outras tabelas
// (from_address / customer_email); a canonical form é só chave de match.
//
// Régua ética: notas ficam DENTRO do operador (dono). Nenhum ponto do
// sistema envia notas ao cliente. PII mascarada em logs.
export const customerNotes = pgTable(
  'customer_notes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    // Email normalizado (chave de agregação). Original preserved em outras
    // tabelas (inbound_emails.from_address, orders.customer_email, etc.).
    emailNormalized: text('email_normalized').notNull(),
    note: text('note').notNull(),
    // Single-user por ora; futuro multi-tenant plugará user_id/role.
    createdBy: text('created_by').notNull().default('operator'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: index('idx_customer_notes_email').on(
      t.storeId,
      t.emailNormalized,
      t.createdAt,
    ),
  }),
);

export type CustomerNote = typeof customerNotes.$inferSelect;
export type NewCustomerNote = typeof customerNotes.$inferInsert;

// ── Macros (Fase 4 — respostas rápidas do operador) ─────────────────────
//
// Textos pré-definidos que o operador aplica no composer com 1 clique
// (política de refund, pedir order number, ack padrão, etc.). NÃO são
// enviados sozinhos — o operador insere no composer, revisa/edita e
// dispara. Passa pelo inbound-response-guard no envio (mesmo caminho de
// manual-reply). Suporta placeholders simples: {{customer_first_name}},
// {{order_number}}, {{shop_name}}.
export const inboundMacros = pgTable(
  'inbound_macros',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    // Categoria opcional (refund_request, order_status, etc.) para UI
    // filtrar/agrupar. Nullable — macro genérica é comum.
    category: text('category'),
    // Ordem manual pro dono controlar exibição (menor primeiro).
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    storeIdx: index('idx_macros_store').on(t.storeId, t.sortOrder),
  }),
);

export type InboundMacro = typeof inboundMacros.$inferSelect;
export type NewInboundMacro = typeof inboundMacros.$inferInsert;

// TrustShield Fase D — Notificações internas do dono (sino do cabeçalho).
//
// Nunca vão ao cliente. Geradas pelo pipeline em eventos críticos
// (chargeback, suspicious_claim) e por criação de refund ticket.
// Idempotentes via unique indexes parciais em (email_id, type) e
// (ticket_id, type).
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    // Tipos conhecidos: 'chargeback_threat' | 'suspicious_claim' |
    // 'refund_pending_approval'. Texto livre para extensão futura sem
    // migration; o dicionário PT-BR (Fase A) mapeia rótulos.
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    // Rota destino ao clicar (ex.: /trustshield/inbox/[id]).
    link: text('link'),
    // 'critical' | 'warning' | 'info'.
    severity: text('severity').notNull().default('info'),
    readAt: timestamp('read_at', { withTimezone: true }),
    relatedEmailId: uuid('related_email_id'),
    relatedTicketId: uuid('related_ticket_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    feedIdx: index('idx_notifications_feed').on(t.storeId, t.createdAt),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

// ── AI usage log (Story 12.1 — AI prompt generator) ───────────────────────────
//
// Rastreia todas as gerações do endpoint /api/editor/ai/generate-image-prompts
// (mock ou real). Uso: (a) rate limit por user_id em janela de 24h (default
// 30/dia), (b) auditoria de custos por chamada, (c) cap operacional futuro.
//
// userId: single-user backoffice grava sempre 'operator' (mesmo padrão de
// customer_notes.created_by). sessionId: reservado para expansão v2 (uso
// público/anônimo), sempre NULL no MVP.
//
// mode: 'mock' | 'real' — permite separar métricas de dev/QA de produção.
// tokens/cost são 0 em modo mock.
export const aiUsageLog = pgTable(
  'ai_usage_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: text('user_id'),
    sessionId: text('session_id'),
    endpoint: text('endpoint').notNull(),
    sectionType: text('section_type'),
    promptCount: integer('prompt_count').notNull().default(3),
    tokensInput: integer('tokens_input').notNull().default(0),
    tokensOutput: integer('tokens_output').notNull().default(0),
    // Story 21.6b · migration 0105 — prompt caching do assistente (tokens_input = entrada SEM cache).
    cacheCreationInputTokens: integer('cache_creation_input_tokens').notNull().default(0),
    cacheReadInputTokens: integer('cache_read_input_tokens').notNull().default(0),
    costEstimateUsd: numeric('cost_estimate_usd', { precision: 10, scale: 6 })
      .notNull()
      .default('0'),
    mode: text('mode').notNull().default('mock'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Rate-limit query lookup — WHERE user_id = $1 AND created_at > now() - '24 hours'.
    userCreatedIdx: index('idx_ai_usage_log_user_created').on(t.userId, t.createdAt),
    sessionCreatedIdx: index('idx_ai_usage_log_session_created').on(t.sessionId, t.createdAt),
  }),
);

export type AiUsageLog = typeof aiUsageLog.$inferSelect;
export type NewAiUsageLog = typeof aiUsageLog.$inferInsert;

// ── Assistente de negócios (Story 21.6 · migration 0104) ─────────────────────
// Conversas por usuário E loja (a API filtra pelos dois; id de outra pessoa/loja = 404).
// Mensagens guardam a pergunta já mascarada (scrubPii) e a resposta — nunca o resultado bruto
// das ferramentas (só os nomes em tools_used). Custo de cada chamada ao modelo vai para
// ai_usage_log (endpoint = 'assistant'); cost_usd aqui é o total da resposta.
export const assistantConversations = pgTable(
  'assistant_conversations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: text('user_id').notNull(),
    storeId: text('store_id').notNull(),
    title: text('title').notNull().default('Nova conversa'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userStoreUpdatedIdx: index('idx_assistant_conversations_user_store_updated').on(t.userId, t.storeId, t.updatedAt),
  }),
);

export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    // 'user' | 'assistant' (CHECK na migration)
    role: text('role').notNull(),
    content: text('content').notNull(),
    toolsUsed: jsonb('tools_used').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    tokensInput: integer('tokens_input').notNull().default(0),
    tokensOutput: integer('tokens_output').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversationCreatedIdx: index('idx_assistant_messages_conversation_created').on(t.conversationId, t.createdAt),
  }),
);

// Linha única (id = 1, CHECK na migration): liga/desliga e teto diário em USD.
export const assistantSettings = pgTable('assistant_settings', {
  id: smallint('id').primaryKey().default(1),
  enabled: boolean('enabled').notNull().default(true),
  dailyCapUsd: numeric('daily_cap_usd', { precision: 8, scale: 2 }).notNull().default('2.00'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

export type AssistantConversation = typeof assistantConversations.$inferSelect;
export type AssistantMessage = typeof assistantMessages.$inferSelect;
export type AssistantSettingsRow = typeof assistantSettings.$inferSelect;

// ── Tracker (Story Tracker.01) ────────────────────────────────────────────────
//
// Clone estrutural do Tracker do sistema forever-official.com. Cloaker +
// link tracker + histórico de cliques. Recon completo em
// docs/research/tracker-recon/README.md.
//
// Padrão Blackshop: store_id text default 'default', sem RLS, timestamps
// with timezone. Enums declarados como text com comentário (padrão do
// resto do schema — evita pgEnum por consistência).
//
// Nomenclatura: prefix tracker_ em todas as tabelas pra evitar colisão
// com `tracking_pixels`/`tracking_events` (feature de pixel do landinglab).

// tracker_campaigns — uma campanha por produto anunciado no Meta Ads.
// slug é gerado server-side (kebab(name)+'-'+nanoid(8)) e serve como
// identificador público em /api/t/[slug]. meta_campaign_id/traffic_sources
// reservados pra sync futuro com Meta Ads API.
export const trackerCampaigns = pgTable(
  'tracker_campaigns',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    // 'active' | 'paused' | 'archived'
    status: text('status').notNull().default('active'),
    // 'cpc' | 'cpm' | 'cpa'
    costModel: text('cost_model').notNull().default('cpc'),
    metaCampaignId: text('meta_campaign_id'),
    trafficSources: jsonb('traffic_sources'),
    // ISO 3166-1 alpha-2 uppercase. Vazio = campanha global (sem geolock).
    // Preenchido = auto-preset adiciona filtro country NOT in list no White.
    targetCountries: text('target_countries').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUniqueIdx: uniqueIndex('idx_tracker_campaigns_slug').on(t.slug),
    storeStatusIdx: index('idx_tracker_campaigns_store_status').on(t.storeId, t.status),
  }),
);

export type TrackerCampaign = typeof trackerCampaigns.$inferSelect;
export type NewTrackerCampaign = typeof trackerCampaigns.$inferInsert;

// tracker_streams — fluxos de distribuição (cloaker). Cada campanha tem
// N streams avaliados em ordem por order_index. Primeiro que satisfizer
// filter_logic sobre filters[] ganha o clique. Stream sem filtros =
// fallback (catch-all). filters[] é jsonb — schema validado em
// packages/tracker-engine/types.ts (não em DB).
export const trackerStreams = pgTable(
  'tracker_streams',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid('campaign_id').notNull(),
    name: text('name').notNull(),
    orderIndex: integer('order_index').notNull(),
    weight: integer('weight').notNull().default(100),
    isWhitePage: boolean('is_white_page').notNull().default(false),
    // 'active' | 'paused'
    status: text('status').notNull().default('active'),
    // 'AND' | 'OR'
    filterLogic: text('filter_logic').notNull().default('OR'),
    filters: jsonb('filters').notNull().default(sql`'[]'::jsonb`),
    // 'redirect' (extensível: 'proxy', 'block')
    action: text('action').notNull().default('redirect'),
    actionConfig: jsonb('action_config').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignOrderIdx: index('idx_tracker_streams_campaign_order').on(t.campaignId, t.orderIndex),
  }),
);

export type TrackerStream = typeof trackerStreams.$inferSelect;
export type NewTrackerStream = typeof trackerStreams.$inferInsert;

// tracker_clicks — log de todos os cliques capturados pelo endpoint
// /api/t/[slug]. Insert fire-and-forget do edge (não bloqueia latência
// do redirect). stream_id null = bloqueado antes de match (bot óbvio).
// event_id (UUID) reservado pra dedupe no Meta Conversions API (Story 6).
// ip é text (não inet) por consistência com outros logs do Blackshop.
export const trackerClicks = pgTable(
  'tracker_clicks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid('campaign_id').notNull(),
    streamId: uuid('stream_id'),
    eventId: uuid('event_id').notNull().default(sql`gen_random_uuid()`),
    // Geo (IP lookup)
    ip: text('ip').notNull(),
    countryCode: text('country_code'),
    region: text('region'),
    city: text('city'),
    isp: text('isp'),
    proxyDetected: boolean('proxy_detected').notNull().default(false),
    // Device (UA parsing)
    deviceType: text('device_type'),
    os: text('os'),
    browser: text('browser'),
    language: text('language'),
    userAgent: text('user_agent'),
    // Source / attribution
    referer: text('referer'),
    fbclid: text('fbclid'),
    sub1: text('sub1'),
    sub2: text('sub2'),
    sub3: text('sub3'),
    sub4: text('sub4'),
    sub5: text('sub5'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    utmTerm: text('utm_term'),
    // Decisão do motor
    redirectUrl: text('redirect_url'),
    isBot: boolean('is_bot').notNull().default(false),
    isBlocked: boolean('is_blocked').notNull().default(false),
    blockReason: text('block_reason'),
    isConverted: boolean('is_converted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignCreatedIdx: index('idx_tracker_clicks_campaign_created').on(t.campaignId, t.createdAt),
    createdAtIdx: index('idx_tracker_clicks_created_at').on(t.createdAt),
    botBlockedIdx: index('idx_tracker_clicks_bot_blocked').on(t.isBot, t.isBlocked),
  }),
);

export type TrackerClick = typeof trackerClicks.$inferSelect;
export type NewTrackerClick = typeof trackerClicks.$inferInsert;

// tracker_access_rules — blacklist/whitelist reutilizáveis. Cada regra
// tem 1 valor único — se quer bloquear N IPs, cria N regras (padrão
// descoberto no recon do form "Nova regra de acesso"). type=blacklist
// bloqueia matching, whitelist permite apenas matching. target define
// qual campo do click comparar.
export const trackerAccessRules = pgTable(
  'tracker_access_rules',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('default'),
    name: text('name').notNull(),
    // 'blacklist' | 'whitelist'
    type: text('type').notNull(),
    // 'ip' | 'user_agent' | 'isp' | 'country'
    target: text('target').notNull(),
    value: text('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    storeTypeIdx: index('idx_tracker_access_rules_store_type').on(t.storeId, t.type),
  }),
);

export type TrackerAccessRule = typeof trackerAccessRules.$inferSelect;
export type NewTrackerAccessRule = typeof trackerAccessRules.$inferInsert;

// ── Contas e acesso (Story 22.1a-1 · Epic 22) ────────────────────────────────
// Migrations 0101 (users, auth_tokens, auth_audit_log), 0102 (owner semeado sem senha) e
// 0103 (auth_sessions). Tabelas INERTES até a 22.1a-2 (nenhuma rota as lê ainda).
// CHECKs (e-mail minúsculo ≤ 254, papéis, estados, tamanhos) e o trigger append-only da
// auditoria vivem só nas migrations.

/** role ∈ owner | member; status ∈ pending_approval | approved_pending_password | active | rejected | disabled. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    email: text('email').notNull(),
    name: text('name'),
    role: text('role').notNull().default('member'),
    status: text('status').notNull().default('pending_approval'),
    // argon2id (PHC string). NULL = sem senha utilizável.
    passwordHash: text('password_hash'),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    // Janela de 15 min do bloqueio progressivo (D6).
    lastFailedLoginAt: timestamp('last_failed_login_at', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    requestNote: text('request_note'),
    decidedBy: uuid('decided_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailLowerUq: uniqueIndex('uq_users_email_lower').on(sql`lower(${t.email})`),
    statusIdx: index('idx_users_status').on(t.status),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** Convite/redefinição de senha: só o sha256 (hex) do token; uso único e expiração. */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 'invite' | 'reset'
    purpose: text('purpose').notNull(),
    tokenHash: text('token_hash').notNull().unique('auth_tokens_token_hash_key'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    userPurposeOpenIdx: index('idx_auth_tokens_user_purpose_open')
      .on(t.userId, t.purpose)
      .where(sql`${t.usedAt} IS NULL`),
  }),
);

export type AuthToken = typeof authTokens.$inferSelect;
export type NewAuthToken = typeof authTokens.$inferInsert;

/** Trilha append-only (trigger recusa UPDATE/DELETE/TRUNCATE). Nunca senha, hash, token, link ou cookie. */
export const authAuditLog = pgTable(
  'auth_audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    event: text('event').notNull(),
    actorUserId: uuid('actor_user_id'),
    subjectUserId: uuid('subject_user_id').references(() => users.id, { onDelete: 'set null' }),
    emailMasked: text('email_masked'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({
    subjectAtIdx: index('idx_auth_audit_log_subject_at').on(t.subjectUserId, t.at),
    atIdx: index('idx_auth_audit_log_at').on(t.at),
  }),
);

export type AuthAuditLogRow = typeof authAuditLog.$inferSelect;
export type NewAuthAuditLogRow = typeof authAuditLog.$inferInsert;

/** Sessão por usuário (loja do @fastify/session na 22.1a-2). Chave = sha256(sid), nunca o sid. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    sidHash: text('sid_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => ({
    userIdx: index('idx_auth_sessions_user').on(t.userId),
    expiresIdx: index('idx_auth_sessions_expires').on(t.expiresAt),
  }),
);

export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;

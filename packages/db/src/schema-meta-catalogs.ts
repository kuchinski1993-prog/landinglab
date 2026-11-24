// Catálogos Meta por produto (Story 24.1) — catálogo -> itens (kits).
//
// Migration: packages/db/migrations/0111_meta_catalogs.sql (NÃO aplicada;
// exige aprovação explícita do owner). Tabelas isoladas: sem FK para tabelas
// existentes. store_id segue o padrão LandingLab (text, default 'l0i', sem FK).
// Re-exportado em packages/db/src/index.ts.
import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const META_CATALOG_SOURCE_KINDS = ['landing', 'store_product', 'manual'] as const;
export type MetaCatalogSourceKind = (typeof META_CATALOG_SOURCE_KINDS)[number];

export const META_CATALOG_AVAILABILITY = ['in stock', 'out of stock', 'preorder', 'available for order'] as const;
export type MetaCatalogAvailability = (typeof META_CATALOG_AVAILABILITY)[number];

export const META_CATALOG_CONNECTION_STATUSES = ['connected', 'error'] as const;
export type MetaCatalogConnectionStatus = (typeof META_CATALOG_CONNECTION_STATUSES)[number];

export const META_CATALOG_SYNC_STATUSES = ['pending', 'synced', 'error'] as const;
export type MetaCatalogSyncStatus = (typeof META_CATALOG_SYNC_STATUSES)[number];

export interface MetaCatalogVideo {
  url: string;
  tag?: string;
}

export interface MetaCatalogUtm {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
}

export const metaCatalogs = pgTable(
  'meta_catalogs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('l0i'),
    name: text('name').notNull(),
    sourceKind: text('source_kind').$type<MetaCatalogSourceKind>().notNull(),
    sourceRef: text('source_ref'),
    currency: text('currency').notNull(),
    locale: text('locale').notNull(),
    brand: text('brand'),
    defaultDestinationUrl: text('default_destination_url'),
    feedToken: text('feed_token').notNull(),
    active: boolean('active').notNull().default(true),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    // Story 24.4 (migration 0113) · conexão com a Catalog API. meta_token_key é a CHAVE do Vault;
    // o token nunca fica no banco.
    metaCatalogId: text('meta_catalog_id'),
    metaTokenKey: text('meta_token_key'),
    metaCatalogName: text('meta_catalog_name'),
    connectionStatus: text('connection_status').$type<MetaCatalogConnectionStatus>(),
    connectionError: text('connection_error'),
    connectionCheckedAt: timestamp('connection_checked_at', { withTimezone: true }),
    pushEnabled: boolean('push_enabled').notNull().default(false),
    pendingDeletes: jsonb('pending_deletes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    feedTokenIdx: uniqueIndex('idx_meta_catalogs_feed_token').on(t.feedToken),
    storeIdx: index('idx_meta_catalogs_store').on(t.storeId, t.createdAt),
  }),
);

export const metaCatalogItems = pgTable(
  'meta_catalog_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    catalogId: uuid('catalog_id')
      .notNull()
      .references(() => metaCatalogs.id, { onDelete: 'cascade' }),
    retailerId: text('retailer_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    priceMinor: integer('price_minor').notNull(),
    salePriceMinor: integer('sale_price_minor'),
    images: jsonb('images').$type<string[]>().notNull(),
    videos: jsonb('videos').$type<MetaCatalogVideo[]>().notNull().default(sql`'[]'::jsonb`),
    destinationUrl: text('destination_url').notNull(),
    utm: jsonb('utm').$type<MetaCatalogUtm>().notNull().default(sql`'{}'::jsonb`),
    availability: text('availability').$type<MetaCatalogAvailability>().notNull().default('in stock'),
    position: integer('position').notNull().default(0),
    destinationStatus: integer('destination_status'),
    destinationCheckedAt: timestamp('destination_checked_at', { withTimezone: true }),
    syncStatus: text('sync_status').$type<MetaCatalogSyncStatus>(),
    syncError: text('sync_error'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    retailerIdx: uniqueIndex('idx_meta_catalog_items_retailer').on(t.catalogId, t.retailerId),
    positionIdx: index('idx_meta_catalog_items_position').on(t.catalogId, t.position),
    syncIdx: index('idx_meta_catalog_items_sync').on(t.catalogId, t.syncStatus),
  }),
);

export type MetaCatalog = typeof metaCatalogs.$inferSelect;
export type MetaCatalogItem = typeof metaCatalogItems.$inferSelect;

// Story 24.3 · arquivos de mídia enviados ao bucket público `meta-catalog-media` (migration 0112, NÃO
// aplicada). Cada troca gera uma chave nova `_vN` (a Meta guarda a mídia em cache pela URL). A linha
// existe para a limpeza: `replaced` há mais de 7 dias e sem nenhum item apontando → o worker apaga o
// objeto e a linha. `item_id` nulo = arquivo do catálogo (lote ou item ainda não salvo).
export const META_CATALOG_MEDIA_KINDS = ['image', 'video'] as const;
export type MetaCatalogMediaKind = (typeof META_CATALOG_MEDIA_KINDS)[number];
export const META_CATALOG_MEDIA_STATUSES = ['pending', 'active', 'replaced'] as const;
export type MetaCatalogMediaStatus = (typeof META_CATALOG_MEDIA_STATUSES)[number];

export const metaCatalogMedia = pgTable(
  'meta_catalog_media',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('l0i'),
    catalogId: uuid('catalog_id')
      .notNull()
      .references(() => metaCatalogs.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id'),
    kind: text('kind').$type<MetaCatalogMediaKind>().notNull(),
    objectKey: text('object_key').notNull(),
    publicUrl: text('public_url').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    version: integer('version').notNull(),
    status: text('status').$type<MetaCatalogMediaStatus>().notNull().default('pending'),
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    objectKeyIdx: uniqueIndex('idx_meta_catalog_media_object_key').on(t.objectKey),
    versionIdx: index('idx_meta_catalog_media_version').on(t.catalogId, t.itemId, t.kind, t.version),
    gcIdx: index('idx_meta_catalog_media_gc').on(t.status, t.replacedAt),
  }),
);

export type MetaCatalogMedia = typeof metaCatalogMedia.$inferSelect;

// Story 24.4 · histórico do catálogo (migration 0113, NÃO aplicada). Sem IP, user-agent nem token.
export const META_CATALOG_SYNC_EVENT_KINDS = ['feed_read', 'api_push', 'connection_error'] as const;
export type MetaCatalogSyncEventKind = (typeof META_CATALOG_SYNC_EVENT_KINDS)[number];

export const metaCatalogSyncEvents = pgTable(
  'meta_catalog_sync_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('l0i'),
    catalogId: uuid('catalog_id')
      .notNull()
      .references(() => metaCatalogs.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<MetaCatalogSyncEventKind>().notNull(),
    sent: integer('sent'),
    accepted: integer('accepted'),
    rejected: integer('rejected'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    catalogIdx: index('idx_meta_catalog_sync_events_catalog').on(t.catalogId, t.createdAt.desc()),
  }),
);

export type MetaCatalogSyncEvent = typeof metaCatalogSyncEvents.$inferSelect;

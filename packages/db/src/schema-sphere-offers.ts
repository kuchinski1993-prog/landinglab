// Catálogo de Ofertas Sphere (Story 16.1) — Programa -> Funis -> Materiais.
//
// Migration: packages/db/migrations/0109_sphere_offers.sql (NÃO aplicada;
// exige aprovação explícita do owner). Tabelas isoladas: sem FK para tabelas
// LandingLab/VSL. store_id segue o padrão LandingLab (text, default 'l0i', sem FK).
// Re-exportado em packages/db/src/index.ts.
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, numeric, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const SPHERE_OFFER_KINDS = ['vsl', 'dtc'] as const;
export type SphereOfferKind = (typeof SPHERE_OFFER_KINDS)[number];

export const SPHERE_MATERIAL_TYPES = ['vsl', 'file', 'checkout'] as const;
export type SphereMaterialType = (typeof SPHERE_MATERIAL_TYPES)[number];

export const SPHERE_CHECKOUT_POTS = [1, 3, 5] as const;
export type SphereCheckoutPots = (typeof SPHERE_CHECKOUT_POTS)[number];

export const sphereOfferPrograms = pgTable(
  'sphere_offer_programs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('l0i'),
    slug: text('slug').notNull(),
    externalId: text('external_id'),
    title: text('title').notNull(),
    niche: text('niche'),
    country: text('country'),
    currency: text('currency'),
    refCode: text('ref_code'),
    // numeric volta como string no driver postgres-js.
    commission: numeric('commission', { precision: 12, scale: 2 }),
    defaultLandingPageUrl: text('default_landing_page_url'),
    kind: text('kind').$type<SphereOfferKind>().notNull(),
    raw: jsonb('raw').$type<Record<string, unknown>>(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('idx_sphere_offer_programs_slug').on(t.storeId, t.slug),
    nicheIdx: index('idx_sphere_offer_programs_niche').on(t.storeId, t.niche),
    countryIdx: index('idx_sphere_offer_programs_country').on(t.storeId, t.country),
    kindIdx: index('idx_sphere_offer_programs_kind').on(t.storeId, t.kind),
  }),
);

export const sphereOfferFunnels = pgTable(
  'sphere_offer_funnels',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    programId: uuid('program_id')
      .notNull()
      .references(() => sphereOfferPrograms.id, { onDelete: 'cascade' }),
    storeId: text('store_id').notNull().default('l0i'),
    externalId: text('external_id'),
    name: text('name').notNull(),
    // Coluna gerada: alvo do ON CONFLICT do import (id do Sphere ou nome normalizado).
    funnelKey: text('funnel_key').generatedAlwaysAs(
      sql`COALESCE('id:' || external_id, 'name:' || lower(btrim(name)))`,
    ),
    commission: numeric('commission', { precision: 12, scale: 2 }),
    expectedCpa: numeric('expected_cpa', { precision: 12, scale: 2 }),
    avgPaidOrderRate: numeric('avg_paid_order_rate', { precision: 9, scale: 4 }),
    position: integer('position').notNull().default(0),
    raw: jsonb('raw').$type<Record<string, unknown>>(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyIdx: uniqueIndex('idx_sphere_offer_funnels_key').on(t.programId, t.funnelKey),
  }),
);

export const sphereOfferMaterials = pgTable(
  'sphere_offer_materials',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    funnelId: uuid('funnel_id')
      .notNull()
      .references(() => sphereOfferFunnels.id, { onDelete: 'cascade' }),
    storeId: text('store_id').notNull().default('l0i'),
    type: text('type').$type<SphereMaterialType>().notNull(),
    title: text('title'),
    url: text('url').notNull(),
    pots: smallint('pots').$type<SphereCheckoutPots>(),
    fn: text('fn'),
    position: integer('position').notNull().default(0),
    raw: jsonb('raw').$type<Record<string, unknown>>(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    identityIdx: uniqueIndex('idx_sphere_offer_materials_identity').on(t.funnelId, t.type, t.url),
  }),
);

export type SphereOfferProgram = typeof sphereOfferPrograms.$inferSelect;
export type NewSphereOfferProgram = typeof sphereOfferPrograms.$inferInsert;
export type SphereOfferFunnel = typeof sphereOfferFunnels.$inferSelect;
export type NewSphereOfferFunnel = typeof sphereOfferFunnels.$inferInsert;
export type SphereOfferMaterial = typeof sphereOfferMaterials.$inferSelect;
export type NewSphereOfferMaterial = typeof sphereOfferMaterials.$inferInsert;

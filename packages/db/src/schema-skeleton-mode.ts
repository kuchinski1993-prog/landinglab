// Skeleton Mode — Drizzle schema pra tabelas novas (migrations 0066/0067).
//
// Referências:
//   - Migrations: packages/db/migrations/0066_skeleton_mode_landing_pages.sql
//                 packages/db/migrations/0067_skeleton_mode_tables.sql
//   - PRD:        docs/prd/skeleton-mode.md v1.0.0
//   - Schema:     docs/architecture/skeleton-mode-schema.md §4.2-4.5
//
// Re-exportado em packages/db/src/index.ts.
//
// Notas:
//   - As 7 colunas novas em `landing_pages` (skeleton_id, skeleton_source_url,
//     reviews_source, logo_source, skeleton_status, extra_sections,
//     identity_visual) ainda NÃO foram adicionadas ao TS de `landingPages` em
//     schema-landinglab-core.ts. Consumidores que precisarem lê-las devem usar
//     raw SQL até story de refactor cruzar (evitar tocar arquivo de 500+ linhas
//     em story de fundação). CHECK constraints permanecem enforced no banco.
//   - FK de skeletonSourceSnapshots.landingPageId é hard (ON DELETE CASCADE).
//   - FK de landing_pages.skeleton_id → skeleton_versions.id é SOFT (sem
//     referência Drizzle) por design — ver schema doc §5.1 (deprecação de
//     skeleton sem quebrar landings antigas).

import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

import { landingPages } from './schema-landinglab-core.js';

// ─────────────────────────────────────────────────────────────────────────
// 1. skeleton_versions
//    Catálogo de skeletons React SSR disponíveis (FR-8, FR-27, CON-3).
// ─────────────────────────────────────────────────────────────────────────

export const skeletonVersions = pgTable('skeleton_versions', {
  // Formato {marca}-{tipo}-v{N}. Enforced por CHECK regex no SQL.
  id: varchar('id', { length: 50 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  // 'advertorial' | 'landing' — CHECK no banco.
  type: text('type').notNull(),
  // Path relativo ao repo do componente React SSR.
  componentPath: text('component_path').notNull(),
  // Shape: {fixed: [{slot_id,name,required,type}], dynamic: {max_count, allowed_types}}
  slotsConfig: jsonb('slots_config').notNull(),
  // false = deprecated (novas landings não podem escolher, antigas continuam).
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────
// 2. skeleton_source_snapshots
//    Evidência da extração da fonte (FR-26, NFR-3, NFR-5).
//    1 landing → N snapshots (re-extração = INSERT, nunca UPDATE).
// ─────────────────────────────────────────────────────────────────────────

export const skeletonSourceSnapshots = pgTable(
  'skeleton_source_snapshots',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id, { onDelete: 'cascade' }),
    sourceUrl: text('source_url').notNull(),
    // NULL = HTML raw não medido; raw NÃO é persistido por NFR-3.
    sourceHtmlSizeBytes: integer('source_html_size_bytes'),
    // Path Supabase Storage: skeleton-source-snapshots/{landing_page_id}/{snapshot_id}.png
    // NULL se screenshot falhou (extração continua).
    screenshotUrl: text('screenshot_url'),
    // JSON estruturado consumido pelo skeleton-composer. CHECK <= 500KB (NFR-3).
    extractedJson: jsonb('extracted_json').notNull(),
    extractorVersion: varchar('extractor_version', { length: 20 }).notNull(),
    // Score 0-1 por slot: {hero: 0.95, bullets: 0.70, ...}. Default {}.
    extractionConfidence: jsonb('extraction_confidence').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    landingIdIdx: index('idx_skeleton_snapshots_landing_id').on(t.landingPageId, t.createdAt),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// 3. font_substitution
//    Mapa fonte-paga → Google Font (FR-5). Consumido pelo brand-extractor.
// ─────────────────────────────────────────────────────────────────────────

export const fontSubstitution = pgTable(
  'font_substitution',
  {
    // PK = nome da fonte fonte (ex.: 'Circular', 'Helvetica Neue').
    sourceFontFamily: varchar('source_font_family', { length: 100 }).primaryKey(),
    googleFontFamily: varchar('google_font_family', { length: 100 }).notNull(),
    // CSV de weights: '400,600,700'.
    weightMapping: varchar('weight_mapping', { length: 200 }).notNull().default('400,700'),
    // true = auto-adicionada por LLM fallback (revisar periodicamente).
    llmGenerated: boolean('llm_generated').notNull().default(false),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Índice parcial pra revisão de entries LLM pendentes.
    llmPendingIdx: index('idx_font_substitution_llm_pending')
      .on(t.createdAt)
      .where(sql`llm_generated = true`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// Types inferidos
// ─────────────────────────────────────────────────────────────────────────

export type SkeletonVersion = typeof skeletonVersions.$inferSelect;
export type NewSkeletonVersion = typeof skeletonVersions.$inferInsert;

export type SkeletonSourceSnapshot = typeof skeletonSourceSnapshots.$inferSelect;
export type NewSkeletonSourceSnapshot = typeof skeletonSourceSnapshots.$inferInsert;

export type FontSubstitution = typeof fontSubstitution.$inferSelect;
export type NewFontSubstitution = typeof fontSubstitution.$inferInsert;

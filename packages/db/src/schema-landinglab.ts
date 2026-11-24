// LandingLab AI Autopilot schema — Story 13.3 (Squad 1 Foundation).
//
// Escopo:
//   1. Extension virtual das colunas Autopilot em landing_pages
//      (as colunas físicas ficam definidas em schema-landinglab-core.ts após reload;
//      esta camada expõe os tipos TS que refletem migration 0047).
//   2. landing_pir_documents — versões do Product Intelligence Report
//   3. landing_generation_runs — audit trail por squad (research/copy/visual/build/deploy)
//
// Referências:
//   - Migration: packages/db/migrations/0047_landinglab_ai_foundation.sql
//   - Story:     docs/stories/13.3.landinglab-ai-foundation.story.md (AC1-AC4)
//   - PIR shape: packages/landinglab-research/src/schema/pir.ts
//
// Convenções idênticas ao schema-landinglab-core.ts:
//   - camelCase TS ↔ snake_case SQL
//   - uuid PKs via gen_random_uuid()
//   - timestamptz para tudo
//   - jsonb com defaults SQL

import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { landingPages } from './schema-landinglab-core.js';

// ─────────────────────────────────────────────────────────────────────────
// 1. Autopilot extension of landing_pages (colunas ADD via migration 0047)
//
// Nota: as colunas físicas foram adicionadas na migration 0047 via ALTER TABLE.
// Este objeto expõe uma view Drizzle das colunas Autopilot para queries
// que só precisam desses campos, sem carregar toda a landing_pages.
// Uso preferencial: importar `landingPages` e usar os campos autopilot direto
// (após regeneração via drizzle-kit); este helper é fallback tipado.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Autopilot columns present on `landing_pages` after migration 0047.
 * Consumido por queries de leitura; escrita usa `landingPages` diretamente
 * (uma vez que schema-landinglab-core.ts seja atualizado num future refactor).
 */
export interface LandingPageAutopilotFields {
  generationMode: 'manual' | 'autopilot';
  sourceType: 'aliexpress_link' | 'photo_upload' | 'other_url' | null;
  sourceUrl: string | null;
  sourceImageUrl: string | null;
  targetLanguage: 'de' | 'it' | 'en' | 'es' | 'fr' | null;
  pirDocumentId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. landing_pir_documents
// ─────────────────────────────────────────────────────────────────────────

export const landingPirDocuments = pgTable(
  'landing_pir_documents',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id, { onDelete: 'cascade' }),
    // Incrementa a cada re-run do Squad 1 (histórico completo).
    version: integer('version').notNull().default(1),
    // JSON validado por Zod (packages/landinglab-research/src/schema/pir.ts).
    // Mantido jsonb (não colunas rígidas) pra permitir iteração rápida da shape.
    content: jsonb('content').notNull(),
    // Lacunas explícitas — Article IV (No Invention). Schema Zod exige length >= 1.
    evidenceGaps: text('evidence_gaps').array().notNull().default(sql`'{}'::text[]`),
    // 0.00 - 1.00. Fórmula mecânica no synthesizer (não subjetivo).
    confidenceScore: numeric('confidence_score', { precision: 3, scale: 2 }),
    // Array de { agent, provider, cited_url } — bibliografia da PIR.
    sources: jsonb('sources').notNull().default(sql`'[]'::jsonb`),
    // Identifica synthesizer que assinou (ex.: 'pir-synthesizer@opus-4.7').
    generatedByAgent: text('generated_by_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Query mais comum: "última PIR da landing X".
    lpVersionIdx: index('idx_landing_pir_documents_lp_version').on(
      t.landingPageId,
      t.version,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// 3. landing_generation_runs
// ─────────────────────────────────────────────────────────────────────────

/**
 * Valores válidos para landing_generation_runs.squad (CHECK constraint no DB).
 *
 * Extensões:
 *   - Migration 0066 adicionou: skeleton_extractor, brand_extractor, skeleton_composer
 *   - Migration 0068 adicionou: translate (SM-3.4)
 */
export const GENERATION_SQUADS = [
  'product_research',
  'copy',
  'visual',
  'build',
  'deploy',
  'skeleton_extractor',
  'brand_extractor',
  'skeleton_composer',
  'translate',
] as const;
export type GenerationSquad = (typeof GENERATION_SQUADS)[number];

/**
 * Valores válidos para landing_generation_runs.status (CHECK constraint no DB).
 */
export const GENERATION_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const landingGenerationRuns = pgTable(
  'landing_generation_runs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id, { onDelete: 'cascade' }),
    // GENERATION_SQUADS enum enforced by DB CHECK.
    squad: text('squad').notNull(),
    // GENERATION_STATUSES enum enforced by DB CHECK.
    status: text('status').notNull().default('queued'),
    // Payload que iniciou o run (sourceUrl/hint/target_language/etc).
    input: jsonb('input').notNull().default(sql`'{}'::jsonb`),
    // Resultado agregado quando status='completed' (ex.: { pir_document_id }).
    output: jsonb('output').notNull().default(sql`'{}'::jsonb`),
    // Populated quando status='failed' (mensagem legível pra humano).
    error: text('error'),
    // Soma de agent_trace[].cost_usd. Numeric(10,4) suporta $999999.9999.
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }).notNull().default('0'),
    durationMs: integer('duration_ms'),
    // Array JSON: [{ agent, provider, tokens_in, tokens_out, cost_usd, latency_ms }].
    agentTrace: jsonb('agent_trace').notNull().default(sql`'[]'::jsonb`),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Query padrão do frontend Generation Progress: "runs da landing X, por squad, mais recente primeiro".
    lpSquadIdx: index('idx_landing_generation_runs_lp_squad').on(
      t.landingPageId,
      t.squad,
      t.startedAt,
    ),
    // Índice parcial pra workers polling: "quais runs precisam de atenção?".
    statusIdx: index('idx_landing_generation_runs_status').on(t.status),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// Type inference helpers (usados por consumers em @blackshop/landinglab-research)
// ─────────────────────────────────────────────────────────────────────────

export type LandingPirDocument = typeof landingPirDocuments.$inferSelect;
export type NewLandingPirDocument = typeof landingPirDocuments.$inferInsert;

export type LandingGenerationRun = typeof landingGenerationRuns.$inferSelect;
export type NewLandingGenerationRun = typeof landingGenerationRuns.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────
// 4. landing_copy_decks (Story 13.4 — Squad 2 Copy)
//
// Uma row por (landing_page_id, language, version). Produzido pelo Squad 2
// (packages/landinglab-copy). Consumido por Squad 3 (Design/Visual).
// Migration: packages/db/migrations/0048_landinglab_copy_squad.sql
// Shape do content: packages/landinglab-copy/src/schema/copy-deck.ts
// ─────────────────────────────────────────────────────────────────────────

/**
 * Valores válidos para landing_copy_decks.language (CHECK constraint no DB).
 * ISO-639-1. Squad 2 gera copy NATIVA em cada idioma (não traduz de EN).
 */
export const COPY_DECK_LANGUAGES = ['en', 'de', 'it', 'fr', 'es'] as const;
export type CopyDeckLanguage = (typeof COPY_DECK_LANGUAGES)[number];

export const landingCopyDecks = pgTable(
  'landing_copy_decks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id, { onDelete: 'cascade' }),
    // Rastreabilidade: qual PIR originou este Copy Deck.
    pirDocumentId: uuid('pir_document_id')
      .notNull()
      .references(() => landingPirDocuments.id),
    // COPY_DECK_LANGUAGES enum enforced by DB CHECK.
    language: text('language').notNull(),
    // Incrementa a cada re-run do Squad 2 pra mesma (landing, idioma).
    version: integer('version').notNull().default(1),
    // Copy Deck completo validado por Zod (packages/landinglab-copy/src/schema/copy-deck.ts).
    content: jsonb('content').notNull(),
    // Array de { block, agent, confidence? } — rastreabilidade de contribuição.
    contributingAgents: jsonb('contributing_agents').notNull().default(sql`'[]'::jsonb`),
    // Soma agent_trace[].cost_usd dos 6 agentes. Numeric(10,4) suporta $999999.9999.
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }).notNull().default('0'),
    // Racional do Copy Chief: seleção de blocos vencedores + validation_warnings[].
    chiefNotes: text('chief_notes'),
    // Identifica orquestrador que assinou (ex.: 'landinglab-copy-chief@opus-4.7').
    generatedByAgent: text('generated_by_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Query padrão Squad 3: "última versão do Copy Deck em EN pra landing X".
    lpLangVersionIdx: uniqueIndex('idx_landing_copy_decks_lp_lang_version').on(
      t.landingPageId,
      t.language,
      t.version,
    ),
  }),
);

export type LandingCopyDeck = typeof landingCopyDecks.$inferSelect;
export type NewLandingCopyDeck = typeof landingCopyDecks.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────
// 5. landing_visual_assets (Story 13.5 — Squad 3 Visual & Brand Forge)
//
// Uma row por (landing_page_id, version). Produzido pelo Squad 3
// (packages/landinglab-visual). Consumido por Squad 4 (Builder HTML).
// Assets language-agnostic na v1 (um pacote serve todos os idiomas).
// Migration: packages/db/migrations/0049_landinglab_visual_squad.sql
// Shape do brand/assets: packages/landinglab-visual/src/schema/visual-assets.ts
// ─────────────────────────────────────────────────────────────────────────

export const landingVisualAssets = pgTable(
  'landing_visual_assets',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id, { onDelete: 'cascade' }),
    // Rastreabilidade: qual PIR originou este pacote visual.
    pirDocumentId: uuid('pir_document_id')
      .notNull()
      .references(() => landingPirDocuments.id),
    // Incrementa a cada re-run do Squad 3 pra mesma landing (histórico completo).
    version: integer('version').notNull().default(1),
    // Objeto brand validado por Zod (packages/landinglab-visual/src/schema/visual-assets.ts):
    // { name, tagline, logo_urls, palette (5 cores hex), typography (2 fontes) }.
    brand: jsonb('brand').notNull(),
    // Objeto assets validado por Zod (mesma shape):
    // { hero:{urls_by_size}, lifestyle[], icons[], trust_badges[], before_after[], backgrounds[] }.
    assets: jsonb('assets').notNull(),
    // Array de { agent, asset_type, provider, cost_usd? } — rastreabilidade de contribuição
    // por asset (qual agente + qual provider gerou o quê).
    contributingAgents: jsonb('contributing_agents').notNull().default(sql`'[]'::jsonb`),
    // Soma dos custos por asset gerado (Freepik/Higgsfield APIs). Numeric(10,4).
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }).notNull().default('0'),
    // Racional do Visual Director + registro de fallbacks de provider usados.
    // Article IV enforcement: NUNCA vazio (mínimo 10 chars validado no runtime pelo Zod).
    directorNotes: text('director_notes'),
    // Identifica orquestrador que assinou (ex.: 'landinglab-visual-director@opus-4.7').
    generatedByAgent: text('generated_by_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Query padrão Squad 4: "última versão do pacote visual pra landing X".
    lpVersionIdx: uniqueIndex('idx_landing_visual_assets_lp_version').on(
      t.landingPageId,
      t.version,
    ),
  }),
);

export type LandingVisualAsset = typeof landingVisualAssets.$inferSelect;
export type NewLandingVisualAsset = typeof landingVisualAssets.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────
// 6. landing_deployments (Story 13.8 — Squad 5 Deploy)
//
// Uma row por deployment attempt (subdomain ou custom_domain).
// Produzido pelo Squad 5 (packages/landinglab-deploy). Consumido pelo
// backoffice PublishActions.tsx (Wave 3) para status/polling.
//
// Migration: packages/db/migrations/0051_landinglab_deploy.sql
// Metadata shape validado por Zod:
//   packages/landinglab-deploy/src/schema/deployment.ts
//   (Article IV enforcement: agent_trace min 1)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Valores válidos para landing_deployments.deployment_type (CHECK constraint no DB).
 */
export const DEPLOYMENT_TYPES = ['subdomain', 'custom_domain'] as const;
export type DeploymentType = (typeof DEPLOYMENT_TYPES)[number];

/**
 * Valores válidos para landing_deployments.ssl_status (CHECK constraint no DB).
 */
export const SSL_STATUSES = ['pending', 'provisioned', 'failed'] as const;
export type SslStatus = (typeof SSL_STATUSES)[number];

/**
 * Valores válidos para landing_deployments.deployment_status (CHECK constraint no DB).
 *   queued → provisioning → (awaiting_ssl?) → published
 *                                          ↘ publish_failed
 *   published → unpublished (operator action; row preserved for audit/republish)
 */
export const DEPLOYMENT_STATUSES = [
  'queued',
  'provisioning',
  'awaiting_ssl',
  'published',
  'publish_failed',
  'unpublished',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const landingDeployments = pgTable(
  'landing_deployments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id, { onDelete: 'cascade' }),
    // DEPLOYMENT_TYPES enum enforced by DB CHECK.
    deploymentType: text('deployment_type').notNull(),
    // FQDN — ex.: 'whitening-strips-en.landinglab.app' ou 'whiteningpro.com'.
    hostname: text('hostname').notNull(),
    // 'spaceship' para custom_domain, NULL para subdomain (wildcard DNS).
    dnsProvider: text('dns_provider'),
    // Array de records DNS aplicados: [{ type, name, value, ttl, priority? }].
    dnsRecords: jsonb('dns_records').notNull().default(sql`'[]'::jsonb`),
    // SSL_STATUSES enum enforced by DB CHECK.
    sslStatus: text('ssl_status').notNull().default('pending'),
    // URL usada pelo publish-verifier (health check HTTP).
    verificationUrl: text('verification_url'),
    // DEPLOYMENT_STATUSES enum enforced by DB CHECK.
    deploymentStatus: text('deployment_status').notNull().default('queued'),
    // Article IV: audit trail obrigatório após deploy (agent_trace min 1).
    // Shape Zod: packages/landinglab-deploy/src/schema/deployment.ts
    deploymentMetadata: jsonb('deployment_metadata'),
    // Custo USD (compra Spaceship). 0 para subdomain (wildcard free).
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }).notNull().default('0'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    // Nullable — setado no unpublish; row preservada para audit/republish.
    unpublishedAt: timestamp('unpublished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // UNIQUE via CREATE UNIQUE INDEX na migration (matches idx name).
    hostnameUniqIdx: uniqueIndex('idx_landing_deployments_hostname').on(t.hostname),
    // Backoffice query: "última deployment da landing X por status".
    lpStatusIdx: index('idx_landing_deployments_lp_status').on(
      t.landingPageId,
      t.deploymentStatus,
    ),
  }),
);

export type LandingDeployment = typeof landingDeployments.$inferSelect;
export type NewLandingDeployment = typeof landingDeployments.$inferInsert;

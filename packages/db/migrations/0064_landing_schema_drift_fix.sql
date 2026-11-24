-- Migration 0064 — Consolidação de schema drift (2026-09-16)
--
-- CONTEXTO:
-- Ao longo das Fases Q/R/S houve mudanças ad-hoc no DB que não foram
-- registradas em migration formal, causando descompasso entre schema
-- Drizzle (TS) e Postgres real. Sintoma: rotas usando (landingPages as any)
-- crashavam com "TypeError: Cannot convert undefined or null to object"
-- retornando HTTP 500 com content-length: 0 (cliente vê "Unexpected end
-- of JSON input").
--
-- Esta migration consolida TUDO num único ponto: garante que colunas
-- declaradas no schema Drizzle existam no DB, e adiciona ao Drizzle o que
-- o DB já tem em uso via `as any`.
--
-- Todas ops são IDEMPOTENTES (IF NOT EXISTS). Se você já rodou algum patch
-- ad-hoc, é seguro rodar de novo.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. landing_pages — Fase Q/R (brand + demografia)
-- ─────────────────────────────────────────────────────────────────────
-- Confirmação retroativa. Estas colunas já existem em prod via patch
-- ad-hoc mas ficam aqui pra rebuild em dev/staging não faltar.

ALTER TABLE "landing_pages"
    ADD COLUMN IF NOT EXISTS "brand_from" text,
    ADD COLUMN IF NOT EXISTS "brand_to" text,
    ADD COLUMN IF NOT EXISTS "target_demographic" text;

-- ─────────────────────────────────────────────────────────────────────
-- 2. landing_domains — sync completo (drift crítico)
-- ─────────────────────────────────────────────────────────────────────
-- Schema Drizzle declara colunas de organização (nickname/tags/notes/
-- expires_at) que UI usa mas DB não tinha. UI crashava ao listar.
-- Também: DB tem colunas em uso (alias/store_id/cost_usd/purchased_at/
-- updated_at) que schema Drizzle não sabia — código usava via `as any`.

ALTER TABLE "landing_domains"
    ADD COLUMN IF NOT EXISTS "nickname" text,
    ADD COLUMN IF NOT EXISTS "tags" text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS "notes" text,
    ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;

-- Trigger auto-update em updated_at (idempotente — recria função só se
-- ainda não tiver).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_landing_domains_updated_at ON "landing_domains";
CREATE TRIGGER trg_landing_domains_updated_at
  BEFORE UPDATE ON "landing_domains"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Índice pra alertas de expiração (30 dias).
CREATE INDEX IF NOT EXISTS "idx_landing_domains_expiring"
  ON "landing_domains" ("expires_at")
  WHERE "expires_at" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 3. landing_domain_bindings — sync design (crítico storefront)
-- ─────────────────────────────────────────────────────────────────────
-- Design conflito: DB tinha (is_active, path_prefix). Storefront resolve
-- por (slug, is_default_root). Adicionamos slug/is_default_root sem
-- remover is_active/path_prefix (backward-compat) e backfilamos.

ALTER TABLE "landing_domain_bindings"
    ADD COLUMN IF NOT EXISTS "slug" text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS "is_default_root" boolean NOT NULL DEFAULT false;

-- Backfill: path_prefix (se existia) vira slug. is_active (root=true) vira
-- is_default_root pra slug=''.
UPDATE "landing_domain_bindings"
SET "slug" = COALESCE(NULLIF("path_prefix", ''), '')
WHERE "slug" = '' AND EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'landing_domain_bindings' AND column_name = 'path_prefix'
);

UPDATE "landing_domain_bindings"
SET "is_default_root" = true
WHERE "slug" = '' AND EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'landing_domain_bindings' AND column_name = 'is_active'
);

-- Índice único: 1 default_root por domain_id.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_domain_bindings_default_root"
  ON "landing_domain_bindings" ("domain_id")
  WHERE "is_default_root" = true;

-- Índice único: slug único por domain_id (resolve-landing lookup).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_domain_bindings_slug"
  ON "landing_domain_bindings" ("domain_id", "slug");

-- ─────────────────────────────────────────────────────────────────────
-- 4. landing_variants — FK pro produto Shopify (checkout)
-- ─────────────────────────────────────────────────────────────────────
-- Schema Drizzle referencia productVariantId → product_variants(id).
-- Sem essa coluna, checkout crashava ao buscar variante do produto.

ALTER TABLE "landing_variants"
    ADD COLUMN IF NOT EXISTS "product_variant_id" uuid REFERENCES "product_variants"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_landing_variants_product_variant"
  ON "landing_variants" ("product_variant_id")
  WHERE "product_variant_id" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 5. landing_copy_decks — audit trail Squad 2 (Copy)
-- ─────────────────────────────────────────────────────────────────────
-- Squad 2 Chief agent persiste chief_notes (síntese do orchestrator) e
-- generated_by_agent (nome+versão do modelo). Sem essas colunas, o Squad 2
-- crashava ao tentar salvar Copy Deck do Autopilot.

ALTER TABLE "landing_copy_decks"
    ADD COLUMN IF NOT EXISTS "chief_notes" text,
    ADD COLUMN IF NOT EXISTS "generated_by_agent" text;

-- ─────────────────────────────────────────────────────────────────────
-- 6. landing_visual_assets — audit trail Squad 3 (Visual)
-- ─────────────────────────────────────────────────────────────────────
-- Idem Squad 3: director_notes (síntese Brand Forge) + generated_by_agent.

ALTER TABLE "landing_visual_assets"
    ADD COLUMN IF NOT EXISTS "director_notes" text,
    ADD COLUMN IF NOT EXISTS "generated_by_agent" text;

-- ─────────────────────────────────────────────────────────────────────
-- 7. landing_generation_runs — updated_at (higiene)
-- ─────────────────────────────────────────────────────────────────────
-- Schema Drizzle não declarava updated_at. DB tinha, mas sem trigger.
-- Adiciona trigger pra auto-update.

DROP TRIGGER IF EXISTS trg_landing_generation_runs_updated_at ON "landing_generation_runs";
CREATE TRIGGER trg_landing_generation_runs_updated_at
  BEFORE UPDATE ON "landing_generation_runs"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;

-- Migration 0050 — LandingLab AI Autopilot Squad 4 (Build HTML).
--
-- Contexto:
--   Squad 4 é o final do pipeline LandingLab AI Autopilot. Consome PIR (Squad 1),
--   Copy Decks (Squad 2) e Visual Assets (Squad 3) e produz HTML estático
--   por idioma via React SSR + 5 agentes (template-selector, content-composer,
--   html-builder, seo-optimizer, performance-optimizer). Esta migration é
--   ADITIVA: adiciona 3 colunas à tabela landing_pages para suportar
--   variantes por idioma + audit trail de build.
--
-- Referências:
--   - PRD: docs/prd/l0i-landing-page-system-prd.md
--   - Story: docs/stories/13.6.landinglab-build-squad.story.md (AC1)
--   - Squad 3: migration 0049_landinglab_visual_squad.sql
--
-- Escopo desta migration (ZERO breaking change):
--   1. ADD parent_landing_page_id → self-FK para landing_pages(id) ON DELETE SET NULL.
--      NULL para rows base/EN, aponta pra base nas variantes de idioma.
--   2. ADD content_language char(2) → 'en'|'de'|'it'|'fr'|'es' (CHECK constraint).
--      NULL em rows legadas criadas antes do autopilot.
--   3. ADD build_metadata jsonb → { template_used, generation_notes, agents_used, ... }.
--      NULL em rows manuais; SEMPRE preenchido pelo Squad 4 (Article IV).
--   4. Index em (parent_landing_page_id) → filtragem de variantes.
--   5. Index em (content_language)       → filtragem por idioma no backoffice.
--
-- Compat/regression:
--   - Nenhuma coluna existente é alterada ou removida.
--   - Rows manuais preservam content_language=NULL, parent_landing_page_id=NULL.
--   - Unique index existente (idx_landing_pages_store_slug em (store_id, slug))
--     lida com conflitos de slug: Squad 4 usa slug composto {slug_base}-{lang}
--     para variantes, evitando colisão com o slug base. ON CONFLICT no INSERT
--     do worker (Wave 3) referencia (store_id, slug) — composite.
--   - IF NOT EXISTS em toda operação → migration é idempotente.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. ADD parent_landing_page_id (self-FK, ON DELETE SET NULL)
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "landing_pages"
    ADD COLUMN IF NOT EXISTS "parent_landing_page_id" uuid
    REFERENCES "landing_pages"("id") ON DELETE SET NULL;
--> statement-breakpoint

COMMENT ON COLUMN "landing_pages"."parent_landing_page_id" IS
    'Squad 4: self-FK. NULL para row base/EN. Aponta para row base nas variantes de idioma (DE/IT/FR/ES). ON DELETE SET NULL preserva variantes se base for removida.';
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 2. ADD content_language (char(2) com CHECK enum)
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "landing_pages"
    ADD COLUMN IF NOT EXISTS "content_language" char(2);
--> statement-breakpoint

-- CHECK constraint separada (IF NOT EXISTS não é suportado em ADD CONSTRAINT
-- em Postgres < 16; usar DO block guardado por catalog check).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'landing_pages_content_language_check'
    ) THEN
        ALTER TABLE "landing_pages"
            ADD CONSTRAINT "landing_pages_content_language_check"
            CHECK ("content_language" IS NULL OR "content_language" IN ('en', 'de', 'it', 'fr', 'es'));
    END IF;
END $$;
--> statement-breakpoint

COMMENT ON COLUMN "landing_pages"."content_language" IS
    'ISO-639-1 do idioma do html_body/copy: en|de|it|fr|es. NULL em rows legadas (pré-autopilot). Populado por Squad 4 sempre.';
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 3. ADD build_metadata (jsonb — audit trail do Squad 4)
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "landing_pages"
    ADD COLUMN IF NOT EXISTS "build_metadata" jsonb;
--> statement-breakpoint

COMMENT ON COLUMN "landing_pages"."build_metadata" IS
    'Squad 4 audit trail: { template_used, generation_notes (min 10 chars), agents_used[], seo_scores?, lighthouse_estimate? }. Article IV: sempre preenchido pós-build. NULL apenas em rows manuais.';
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Indexes
-- ─────────────────────────────────────────────────────────────────────────

-- Filtragem de variantes por landing base (backoffice + Squad 4 lookup).
CREATE INDEX IF NOT EXISTS "idx_landing_pages_parent"
    ON "landing_pages" USING btree ("parent_landing_page_id")
    WHERE "parent_landing_page_id" IS NOT NULL;
--> statement-breakpoint

-- Filtragem por idioma (backoffice tabs, storefront routing por locale).
CREATE INDEX IF NOT EXISTS "idx_landing_pages_content_language"
    ON "landing_pages" USING btree ("content_language")
    WHERE "content_language" IS NOT NULL;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- ROLLBACK (executar manualmente):
-- ═════════════════════════════════════════════════════════════════════════
--
-- DROP INDEX IF EXISTS "idx_landing_pages_content_language";
-- DROP INDEX IF EXISTS "idx_landing_pages_parent";
-- ALTER TABLE "landing_pages"
--     DROP CONSTRAINT IF EXISTS "landing_pages_content_language_check";
-- ALTER TABLE "landing_pages" DROP COLUMN IF EXISTS "build_metadata";
-- ALTER TABLE "landing_pages" DROP COLUMN IF EXISTS "content_language";
-- ALTER TABLE "landing_pages" DROP COLUMN IF EXISTS "parent_landing_page_id";
--
-- Nota: rollback perde audit trail de build (build_metadata) das rows
-- geradas pelo Squad 4. Landings em produção precisam re-rodar Squad 4
-- após rollback+forward para restaurar build_metadata e variantes de idioma.

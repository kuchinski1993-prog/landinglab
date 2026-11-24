-- Migration 0066 — Skeleton Mode: colunas em landing_pages
--
-- Referências:
--   - PRD:    docs/prd/skeleton-mode.md v1.0.0
--   - Schema: docs/architecture/skeleton-mode-schema.md §4.1
--
-- Adiciona 7 colunas nullable/com-default em landing_pages para suportar
-- Skeleton Mode. Rows legadas preservam semântica (defaults seguros +
-- retro-fill de skeleton_status espelhando status).
--
-- Zero breaking change:
--   - Nenhuma coluna existente é alterada.
--   - Novas colunas têm defaults sensatos (reviews_source='extracted',
--     logo_source='generated_brand_forge', skeleton_status derivado do status).
--   - CHECK constraints só validam os valores novos — não afetam INSERTs
--     antigos que já não populam esses campos.
--
-- Ver §12 do doc de schema pra Gaps do PRD que precisam decisão do dono
-- antes de fechar implementação.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. ALTER landing_pages — 7 colunas novas
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "landing_pages"
    ADD COLUMN IF NOT EXISTS "skeleton_id" varchar(50),
    ADD COLUMN IF NOT EXISTS "skeleton_source_url" text,
    ADD COLUMN IF NOT EXISTS "reviews_source" text NOT NULL DEFAULT 'extracted',
    ADD COLUMN IF NOT EXISTS "logo_source" text NOT NULL DEFAULT 'generated_brand_forge',
    ADD COLUMN IF NOT EXISTS "skeleton_status" text NOT NULL DEFAULT 'draft',
    ADD COLUMN IF NOT EXISTS "extra_sections" jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS "identity_visual" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 2. CHECK constraints (soft enums + shape guards, idempotentes)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
    -- reviews_source enum (FR-24, CON-1)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_reviews_source_check'
    ) THEN
        ALTER TABLE "landing_pages"
            ADD CONSTRAINT "landing_pages_reviews_source_check"
            CHECK ("reviews_source" IN ('extracted', 'ai_generated', 'manual'));
    END IF;

    -- logo_source enum (FR-25, CON-2) — pending_regeneration é estado transitório
    -- do kill switch replaceExtractedLogos() (§9.3 do schema doc).
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_logo_source_check'
    ) THEN
        ALTER TABLE "landing_pages"
            ADD CONSTRAINT "landing_pages_logo_source_check"
            CHECK ("logo_source" IN (
                'extracted_from_fonte',
                'generated_brand_forge',
                'manual_upload',
                'pending_regeneration'
            ));
    END IF;

    -- skeleton_status enum (métrica §11.1 do PRD)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_skeleton_status_check'
    ) THEN
        ALTER TABLE "landing_pages"
            ADD CONSTRAINT "landing_pages_skeleton_status_check"
            CHECK ("skeleton_status" IN ('draft', 'edited', 'published', 'archived'));
    END IF;

    -- skeleton_id formato: {marca}-{tipo}-v{N} — ex.: bepurex-landing-v1
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_skeleton_id_format_check'
    ) THEN
        ALTER TABLE "landing_pages"
            ADD CONSTRAINT "landing_pages_skeleton_id_format_check"
            CHECK ("skeleton_id" IS NULL OR "skeleton_id" ~ '^[a-z][a-z0-9-]{2,49}$');
    END IF;

    -- extra_sections MUST be a JSON array (não obj, não null quando presente)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_extra_sections_is_array_check'
    ) THEN
        ALTER TABLE "landing_pages"
            ADD CONSTRAINT "landing_pages_extra_sections_is_array_check"
            CHECK (jsonb_typeof("extra_sections") = 'array');
    END IF;

    -- identity_visual MUST be a JSON object
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_identity_visual_is_object_check'
    ) THEN
        ALTER TABLE "landing_pages"
            ADD CONSTRAINT "landing_pages_identity_visual_is_object_check"
            CHECK (jsonb_typeof("identity_visual") = 'object');
    END IF;
END $$;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 3. COMMENT ON COLUMN — documentação inline (padrão do projeto)
-- ─────────────────────────────────────────────────────────────────────────

COMMENT ON COLUMN "landing_pages"."skeleton_id" IS
    'FK-soft para skeleton_versions.id. NULL = landing criada via cloner clássico ou autopilot pré-Skeleton Mode. Formato: {marca}-{tipo}-v{N}, ex.: bepurex-landing-v1. FR-27. Sem FK hard pra permitir deprecação de skeletons (is_active=false) sem quebrar landings antigas — validação de existência fica na aplicação (Zod).';
COMMENT ON COLUMN "landing_pages"."skeleton_source_url" IS
    'URL da landing fonte que alimentou o skeleton-extractor. Auditoria + re-extração futura. NULL para landings não-skeleton. FR-3.';
COMMENT ON COLUMN "landing_pages"."reviews_source" IS
    'Origem dos reviews exibidos: extracted (da fonte) | ai_generated (LLM) | manual (dono digitou). Kill switch deleteAIGeneratedReviews() filtra por ai_generated (< 1min por NFR-2). Default extracted preserva semântica em rows legadas. FR-24, CON-1, NFR-6.';
COMMENT ON COLUMN "landing_pages"."logo_source" IS
    'Origem do logo: extracted_from_fonte | generated_brand_forge (padrão) | manual_upload | pending_regeneration (transitório do kill switch). Kill switch replaceExtractedLogos() troca extracted → pending → generated. FR-25, CON-2, NFR-7.';
COMMENT ON COLUMN "landing_pages"."skeleton_status" IS
    'Status estendido do painel Skeleton Mode: draft | edited | published | archived. Complementa landing_pages.status (que continua sendo hard status do storefront). Retro-fill: rows pré-0066 espelham status. Aplicação DEVE setar edited em UPDATE de campo de conteúdo (métrica §11.1). FR-15, FR-16, FR-18.';
COMMENT ON COLUMN "landing_pages"."extra_sections" IS
    'Array (até 3) das seções dinâmicas aprovadas pelo dono. Item: {slot_id, name, html, confidence}. FR-7 (Nível 2.5, 12 fixos + 3 dinâmicos).';
COMMENT ON COLUMN "landing_pages"."identity_visual" IS
    'Identidade visual final: {primary, secondary, text, background, fontHeading, fontBody, logoUrl, contrastAdjusted?}. Populada por brand-extractor (FR-4) + WCAG (FR-6) + font-substitution (FR-5). Empty {} em landings não-skeleton.';
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Índices — otimizam dashboard + kill switches + métrica 80%
-- ─────────────────────────────────────────────────────────────────────────

-- Dashboard "Minhas landings Skeleton Mode"
CREATE INDEX IF NOT EXISTS "idx_landing_pages_skeleton_id"
    ON "landing_pages" ("skeleton_id")
    WHERE "skeleton_id" IS NOT NULL;
--> statement-breakpoint

-- Dashboard "Rascunhos ativos"
CREATE INDEX IF NOT EXISTS "idx_landing_pages_skeleton_status"
    ON "landing_pages" ("store_id", "skeleton_status")
    WHERE "skeleton_status" IN ('draft', 'edited');
--> statement-breakpoint

-- Kill switch deleteAIGeneratedReviews() — NFR-2 < 1min
CREATE INDEX IF NOT EXISTS "idx_landing_pages_reviews_source_ai"
    ON "landing_pages" ("reviews_source")
    WHERE "reviews_source" = 'ai_generated';
--> statement-breakpoint

-- Kill switch replaceExtractedLogos() — NFR-2 < 1min
CREATE INDEX IF NOT EXISTS "idx_landing_pages_logo_source_extracted"
    ON "landing_pages" ("logo_source")
    WHERE "logo_source" = 'extracted_from_fonte';
--> statement-breakpoint

-- Métrica 80% — landings publicadas via Skeleton Mode
CREATE INDEX IF NOT EXISTS "idx_landing_pages_skeleton_published_at"
    ON "landing_pages" ("skeleton_id", "published_at")
    WHERE "skeleton_id" IS NOT NULL AND "published_at" IS NOT NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Retro-fill skeleton_status pra rows pré-0066
--    Regra: status='published' → skeleton_status='published' (preserva
--    landings antigas como "prontas"), archived idem, resto → draft.
-- ─────────────────────────────────────────────────────────────────────────

UPDATE "landing_pages"
SET "skeleton_status" = CASE
    WHEN "status" = 'published' THEN 'published'
    WHEN "status" = 'archived' THEN 'archived'
    ELSE 'draft'
END
WHERE "skeleton_id" IS NULL
  -- skeleton_status default é 'draft'; só faz UPDATE onde precisa mudar
  AND "skeleton_status" != CASE
      WHEN "status" = 'published' THEN 'published'
      WHEN "status" = 'archived' THEN 'archived'
      ELSE 'draft'
  END;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Bônus: expandir CHECK de landing_generation_runs.squad pros novos
--    agentes do Skeleton Mode (skeleton_extractor, brand_extractor,
--    skeleton_composer). Ver §11.4 do doc de schema.
--
-- Zero risco: rows existentes usam valores originais que continuam válidos.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "landing_generation_runs"
    DROP CONSTRAINT IF EXISTS "landing_generation_runs_squad_check";
--> statement-breakpoint

ALTER TABLE "landing_generation_runs"
    ADD CONSTRAINT "landing_generation_runs_squad_check"
    CHECK ("squad" IN (
        'product_research', 'copy', 'visual', 'build', 'deploy',
        'skeleton_extractor', 'brand_extractor', 'skeleton_composer'
    ));
--> statement-breakpoint

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- ROLLBACK (executar manualmente se necessário):
-- ═════════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--
-- -- Reverter CHECK do landing_generation_runs pra versão pré-0066
-- ALTER TABLE landing_generation_runs
--   DROP CONSTRAINT IF EXISTS landing_generation_runs_squad_check;
-- ALTER TABLE landing_generation_runs
--   ADD CONSTRAINT landing_generation_runs_squad_check
--   CHECK (squad IN ('product_research','copy','visual','build','deploy'));
--
-- -- DROP índices
-- DROP INDEX IF EXISTS idx_landing_pages_skeleton_id;
-- DROP INDEX IF EXISTS idx_landing_pages_skeleton_status;
-- DROP INDEX IF EXISTS idx_landing_pages_reviews_source_ai;
-- DROP INDEX IF EXISTS idx_landing_pages_logo_source_extracted;
-- DROP INDEX IF EXISTS idx_landing_pages_skeleton_published_at;
--
-- -- DROP constraints
-- ALTER TABLE landing_pages
--   DROP CONSTRAINT IF EXISTS landing_pages_reviews_source_check,
--   DROP CONSTRAINT IF EXISTS landing_pages_logo_source_check,
--   DROP CONSTRAINT IF EXISTS landing_pages_skeleton_status_check,
--   DROP CONSTRAINT IF EXISTS landing_pages_skeleton_id_format_check,
--   DROP CONSTRAINT IF EXISTS landing_pages_extra_sections_is_array_check,
--   DROP CONSTRAINT IF EXISTS landing_pages_identity_visual_is_object_check;
--
-- -- DROP colunas
-- ALTER TABLE landing_pages
--   DROP COLUMN IF EXISTS identity_visual,
--   DROP COLUMN IF EXISTS extra_sections,
--   DROP COLUMN IF EXISTS skeleton_status,
--   DROP COLUMN IF EXISTS logo_source,
--   DROP COLUMN IF EXISTS reviews_source,
--   DROP COLUMN IF EXISTS skeleton_source_url,
--   DROP COLUMN IF EXISTS skeleton_id;
--
-- COMMIT;
--
-- Nota: rollback preserva rows criadas com skeleton_id — HTML fica intacto,
-- só perde rastreabilidade Skeleton Mode. Landings clássicas permanecem
-- 100% intocadas.

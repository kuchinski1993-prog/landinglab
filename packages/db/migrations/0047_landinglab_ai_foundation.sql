-- Migration 0047 — LandingLab AI Autopilot Foundation (Story 13.3).
--
-- Contexto:
--   Adiciona modo Autopilot ao L0i. Uma landing pode ser criada em modo
--   'manual' (fluxo Story 13.2, HTML colado) OU 'autopilot' (IA gera copy,
--   marca, visual, HTML — squads implementados nesta e nas próximas stories).
--   Esta migration entrega a foundation de dados do Squad 1 (Product Research).
--
-- Referências:
--   - PRD: docs/prd/l0i-landing-page-system-prd.md
--   - Story: docs/stories/13.3.landinglab-ai-foundation.story.md (AC1-AC4)
--   - Squad 1 README: .claude/agents/landinglab-squad-1-README.md
--
-- Escopo desta migration (ZERO breaking change):
--   1. ALTER landing_pages: 5 colunas NEW nullable + defaults sensatos
--   2. NEW TABLE landing_pir_documents — 1..N por landing (versão do PIR)
--   3. NEW TABLE landing_generation_runs — audit trail por squad (research,
--      copy, visual, build, deploy) com cost/duration/agent_trace.
--
-- Compat/regression:
--   - Rows existentes em landing_pages continuam válidas (generation_mode
--     default 'manual' preserva semântica atual da Story 13.2).
--   - Nenhuma coluna existente é alterada nem tem NOT NULL introduzido.
--   - FKs adicionadas apontam pra tabelas novas, sem tocar as antigas.
--   - Rollback simples (DROP FKs + DROP tables + ALTER TABLE DROP COLUMN),
--     documentado no final.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. ALTER landing_pages — adicionar colunas Autopilot (todas nullable)
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "landing_pages"
    ADD COLUMN IF NOT EXISTS "generation_mode" text NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS "source_type" text,
    ADD COLUMN IF NOT EXISTS "source_url" text,
    ADD COLUMN IF NOT EXISTS "source_image_url" text,
    ADD COLUMN IF NOT EXISTS "target_language" char(2),
    ADD COLUMN IF NOT EXISTS "pir_document_id" uuid;
--> statement-breakpoint

-- CHECK constraints — soft enums (permitem NULL onde aplicável).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_generation_mode_check'
    ) THEN
        ALTER TABLE "landing_pages"
            ADD CONSTRAINT "landing_pages_generation_mode_check"
            CHECK ("generation_mode" IN ('manual', 'autopilot'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_source_type_check'
    ) THEN
        ALTER TABLE "landing_pages"
            ADD CONSTRAINT "landing_pages_source_type_check"
            CHECK ("source_type" IS NULL OR "source_type" IN (
                'aliexpress_link', 'photo_upload', 'other_url'
            ));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_target_language_check'
    ) THEN
        ALTER TABLE "landing_pages"
            ADD CONSTRAINT "landing_pages_target_language_check"
            CHECK ("target_language" IS NULL OR "target_language" IN (
                'de', 'it', 'en', 'es', 'fr'
            ));
    END IF;
END $$;
--> statement-breakpoint

COMMENT ON COLUMN "landing_pages"."generation_mode" IS
    'manual | autopilot. Default manual preserva rows existentes (Story 13.2).';
COMMENT ON COLUMN "landing_pages"."source_type" IS
    'Somente autopilot: aliexpress_link | photo_upload | other_url.';
COMMENT ON COLUMN "landing_pages"."target_language" IS
    'Idioma-alvo da landing gerada (de, it, en, es, fr). NULL em modo manual.';
COMMENT ON COLUMN "landing_pages"."pir_document_id" IS
    'FK pro PIR mais recente (setado depois que Squad 1 completa; FK definida abaixo).';
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 2. NEW TABLE landing_pir_documents — versões do Product Intelligence Report
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "landing_pir_documents" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "landing_page_id" uuid NOT NULL
        REFERENCES "landing_pages"("id") ON DELETE CASCADE,
    "version" integer NOT NULL DEFAULT 1,
    -- Estrutura completa validada por Zod schema em packages/landinglab-research/src/schema/pir.ts.
    -- Manter jsonb (não jsonb + shape rígido em SQL) permite iterar rápido.
    "content" jsonb NOT NULL,
    -- Array de lacunas de evidência ("o que Sage não conseguiu verificar").
    -- Schema Zod exige length >= 1 (Article IV — No Invention).
    "evidence_gaps" text[] NOT NULL DEFAULT '{}'::text[],
    "confidence_score" numeric(3, 2),
    "sources" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "generated_by_agent" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "landing_pir_documents_version_check"
        CHECK ("version" >= 1),
    CONSTRAINT "landing_pir_documents_confidence_check"
        CHECK ("confidence_score" IS NULL OR
               ("confidence_score" >= 0 AND "confidence_score" <= 1))
);
--> statement-breakpoint

COMMENT ON TABLE "landing_pir_documents" IS
    'Product Intelligence Report (PIR) por landing. Versionado — cada re-run gera nova version. Consumido por Squads 2-5.';
COMMENT ON COLUMN "landing_pir_documents"."content" IS
    'JSON completo do PIR (identity, market, avatar, voc, desired_outcomes, awareness_stages, value_equation, evidence). Shape em packages/landinglab-research/src/schema/pir.ts.';
COMMENT ON COLUMN "landing_pir_documents"."evidence_gaps" IS
    'Lacunas explícitas — o que a IA NÃO conseguiu verificar. Enforcement anti-invenção (Constitution IV).';
COMMENT ON COLUMN "landing_pir_documents"."generated_by_agent" IS
    'Agent que assinou o PIR (ex.: landinglab-pir-synthesizer@opus-4.7). Auditoria.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_landing_pir_documents_lp_version"
    ON "landing_pir_documents" USING btree ("landing_page_id", "version" DESC);
--> statement-breakpoint

-- FK diferida em landing_pages → aponta pro PIR mais recente (setada pelo app após persistir).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_pir_document_id_fk'
    ) THEN
        ALTER TABLE "landing_pages"
            ADD CONSTRAINT "landing_pages_pir_document_id_fk"
            FOREIGN KEY ("pir_document_id")
            REFERENCES "landing_pir_documents"("id")
            ON DELETE SET NULL;
    END IF;
END $$;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 3. NEW TABLE landing_generation_runs — audit trail por squad
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "landing_generation_runs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "landing_page_id" uuid NOT NULL
        REFERENCES "landing_pages"("id") ON DELETE CASCADE,
    "squad" text NOT NULL,
    "status" text NOT NULL DEFAULT 'queued',
    "input" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "output" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "error" text,
    "cost_usd" numeric(10, 4) NOT NULL DEFAULT 0,
    "duration_ms" integer,
    -- agent_trace: array de invocações [{ agent, provider, tokens_in,
    --                                     tokens_out, cost_usd, latency_ms }].
    "agent_trace" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "landing_generation_runs_squad_check"
        CHECK ("squad" IN (
            'product_research', 'copy', 'visual', 'build', 'deploy'
        )),
    CONSTRAINT "landing_generation_runs_status_check"
        CHECK ("status" IN (
            'queued', 'running', 'completed', 'failed', 'cancelled'
        ))
);
--> statement-breakpoint

COMMENT ON TABLE "landing_generation_runs" IS
    'Audit trail: 1 row por invocação de squad. UI Generation Progress lê daqui via polling.';
COMMENT ON COLUMN "landing_generation_runs"."agent_trace" IS
    'Array JSON de invocações externas: [{agent, provider, tokens_in, tokens_out, cost_usd, latency_ms}]. Soma cost_usd deve bater com landing_generation_runs.cost_usd.';
COMMENT ON COLUMN "landing_generation_runs"."cost_usd" IS
    'Custo total do run (soma agent_trace.cost_usd). Numeric(10,4) suporta $999999.9999.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_landing_generation_runs_lp_squad"
    ON "landing_generation_runs" USING btree
    ("landing_page_id", "squad", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_landing_generation_runs_status"
    ON "landing_generation_runs" USING btree ("status")
    WHERE "status" IN ('queued', 'running');
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- ROLLBACK (executar manualmente):
-- ═════════════════════════════════════════════════════════════════════════
--
-- ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_pir_document_id_fk";
-- DROP TABLE IF EXISTS "landing_generation_runs";
-- DROP TABLE IF EXISTS "landing_pir_documents";
--
-- ALTER TABLE "landing_pages"
--     DROP CONSTRAINT IF EXISTS "landing_pages_generation_mode_check",
--     DROP CONSTRAINT IF EXISTS "landing_pages_source_type_check",
--     DROP CONSTRAINT IF EXISTS "landing_pages_target_language_check",
--     DROP COLUMN IF EXISTS "pir_document_id",
--     DROP COLUMN IF EXISTS "target_language",
--     DROP COLUMN IF EXISTS "source_image_url",
--     DROP COLUMN IF EXISTS "source_url",
--     DROP COLUMN IF EXISTS "source_type",
--     DROP COLUMN IF EXISTS "generation_mode";
--
-- Nota: rows criadas em generation_mode='autopilot' ficam "órfãs" de PIR
-- após rollback — não perdem HTML nem ficam inválidas, só perdem
-- rastreabilidade IA. Landings manuais permanecem intocadas.

-- Migration 0048 — LandingLab AI Autopilot Squad 2 (Copy High-Conversion).
--
-- Contexto:
--   Squad 2 do LandingLab AI Autopilot: 6 agentes copywriters (Hormozi, Schwartz,
--   Halbert, Cialdini, Voss + Copy Chief orquestrador) que consomem o PIR do
--   Squad 1 e produzem um Copy Deck estruturado por blocos, por idioma.
--   Esta migration entrega a foundation de dados (tabela landing_copy_decks +
--   coluna target_languages em landing_pages).
--
-- Referências:
--   - PRD: docs/prd/l0i-landing-page-system-prd.md
--   - Story: docs/stories/13.4.landinglab-copy-squad.story.md (AC1)
--   - Squad 1: migration 0047_landinglab_ai_foundation.sql (padrão base)
--
-- Escopo desta migration (ZERO breaking change):
--   1. ALTER landing_pages: 1 coluna NEW nullable (target_languages text[])
--      complementa target_language (singular, Squad 1) sem conflito.
--   2. NEW TABLE landing_copy_decks — 1..N por landing (versão × idioma).
--
-- Compat/regression:
--   - Rows existentes em landing_pages continuam válidas (target_languages
--     é nullable — só é populado ao criar landing em modo autopilot).
--   - Nenhuma coluna existente é alterada nem tem NOT NULL introduzido.
--   - FKs adicionadas apontam pra tabelas novas (landing_copy_decks →
--     landing_pages, landing_pir_documents), sem tocar as antigas.
--   - Rollback simples (DROP FKs + DROP table + ALTER TABLE DROP COLUMN),
--     documentado no final.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. ALTER landing_pages — adicionar coluna target_languages (array de idiomas)
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "landing_pages"
    ADD COLUMN IF NOT EXISTS "target_languages" text[];
--> statement-breakpoint

COMMENT ON COLUMN "landing_pages"."target_languages" IS
    'Array de idiomas para o Squad 2 gerar (ex.: [''en'',''de'']). ' ||
    'EN sempre incluso. Complementa target_language (singular, Squad 1). ' ||
    'NULL em modo manual ou landings pré-Story 13.4.';
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 2. NEW TABLE landing_copy_decks — Copy Deck por landing × idioma × versão
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "landing_copy_decks" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "landing_page_id" uuid NOT NULL
        REFERENCES "landing_pages"("id") ON DELETE CASCADE,
    -- Rastreabilidade: qual PIR originou este Copy Deck.
    "pir_document_id" uuid NOT NULL
        REFERENCES "landing_pir_documents"("id"),
    -- ISO-639-1 (2 letras). CHECK constraint restringe aos suportados pelo Squad 2.
    "language" char(2) NOT NULL,
    -- Incrementa a cada re-run do Squad 2 pra mesma landing × idioma (histórico completo).
    "version" integer NOT NULL DEFAULT 1,
    -- Copy Deck completo validado por Zod (packages/landinglab-copy/src/schema/copy-deck.ts).
    -- Mantido jsonb (não colunas rígidas) pra permitir iteração rápida da shape.
    "content" jsonb NOT NULL,
    -- Array de { block, agent, confidence? } — qual copywriter contribuiu cada bloco.
    "contributing_agents" jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Custo agregado da geração (soma agent_trace.cost_usd dos 6 agentes).
    "cost_usd" numeric(10, 4) NOT NULL DEFAULT 0,
    -- Racional do Copy Chief: qual framework "venceu" por bloco e por quê.
    "chief_notes" text,
    -- Identifica orquestrador que assinou (ex.: 'landinglab-copy-chief@opus-4.7').
    "generated_by_agent" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "landing_copy_decks_language_check"
        CHECK ("language" IN ('en', 'de', 'it', 'fr', 'es')),
    CONSTRAINT "landing_copy_decks_version_check"
        CHECK ("version" >= 1)
);
--> statement-breakpoint

COMMENT ON TABLE "landing_copy_decks" IS
    'Copy Deck por landing × idioma × versão. Produzido pelo Squad 2 (Copy). Consumido por Squad 3 (Design/Visual).';
COMMENT ON COLUMN "landing_copy_decks"."content" IS
    'JSON completo do Copy Deck (hooks, subheadlines, benefit_bullets, ctas, faq, offer_stack, guarantee, urgency_copy, social_proof_blocks, voc_verbatim_used). Shape em packages/landinglab-copy/src/schema/copy-deck.ts.';
COMMENT ON COLUMN "landing_copy_decks"."contributing_agents" IS
    'Array JSON [{ block, agent, confidence? }] — rastreabilidade de qual copywriter contribuiu cada bloco.';
COMMENT ON COLUMN "landing_copy_decks"."chief_notes" IS
    'Racional do Copy Chief para seleção de blocos vencedores. Pode incluir validation_warnings[] flags.';
--> statement-breakpoint

-- Unique: garante que cada combinação (landing, idioma, versão) é única.
-- Query padrão do Squad 3: "última versão do Copy Deck em EN pra landing X".
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_copy_decks_lp_lang_version"
    ON "landing_copy_decks" USING btree
    ("landing_page_id", "language", "version" DESC);
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- ROLLBACK (executar manualmente):
-- ═════════════════════════════════════════════════════════════════════════
--
-- DROP INDEX IF EXISTS "idx_landing_copy_decks_lp_lang_version";
-- DROP TABLE IF EXISTS "landing_copy_decks";
--
-- ALTER TABLE "landing_pages"
--     DROP COLUMN IF EXISTS "target_languages";
--
-- Nota: rollback preserva landing_pir_documents (Squad 1) intacto.
-- Landings em generation_mode='autopilot' que já rodaram Squad 2 perdem
-- os Copy Decks mas o PIR permanece — Squad 2 pode re-rodar após rollback+forward.

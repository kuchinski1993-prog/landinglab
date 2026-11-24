-- Migration 0049 — LandingLab AI Autopilot Squad 3 (Visual & Brand Forge).
--
-- Contexto:
--   Squad 3 do LandingLab AI Autopilot: 6 agentes de IA (Visual Director orquestrador,
--   Brand Forge, Hero Designer, Lifestyle Composer, Icon Generator, Social Proof Designer)
--   que consomem o PIR (Squad 1) + Copy Deck EN (Squad 2) e produzem um pacote completo
--   de ativos visuais gerados 100% por IA (hero, lifestyle, ícones, logo, badges, templates).
--   Esta migration entrega a foundation de dados (tabela landing_visual_assets).
--
-- Referências:
--   - PRD: docs/prd/l0i-landing-page-system-prd.md
--   - Story: docs/stories/13.5.landinglab-visual-squad.story.md (AC1)
--   - Squad 1: migration 0047_landinglab_ai_foundation.sql
--   - Squad 2: migration 0048_landinglab_copy_squad.sql
--
-- Escopo desta migration (ZERO breaking change):
--   1. NEW TABLE landing_visual_assets — 1..N por landing (versão).
--      Assets language-agnostic na v1 (um pacote serve todos os idiomas).
--
-- Compat/regression:
--   - Não altera nenhuma tabela existente.
--   - FKs adicionadas apontam pra tabelas novas (landing_pages, landing_pir_documents),
--     sem tocar as antigas.
--   - Rollback simples (DROP INDEX + DROP TABLE), documentado no final.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. NEW TABLE landing_visual_assets — Pacote visual por landing × versão
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "landing_visual_assets" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "landing_page_id" uuid NOT NULL
        REFERENCES "landing_pages"("id") ON DELETE CASCADE,
    -- Rastreabilidade: qual PIR originou este pacote visual.
    "pir_document_id" uuid NOT NULL
        REFERENCES "landing_pir_documents"("id"),
    -- Incrementa a cada re-run do Squad 3 pra mesma landing (histórico completo).
    "version" integer NOT NULL DEFAULT 1,
    -- Objeto brand: name, tagline, logo_urls {full,mark,wordmark},
    -- palette {primary,secondary,accent,bg,text} (5 hex), typography {headline_font, body_font}.
    -- Shape em packages/landinglab-visual/src/schema/visual-assets.ts.
    "brand" jsonb NOT NULL,
    -- Objeto assets: hero {urls_by_size:{desktop,og,mobile}}, lifestyle[], icons[],
    -- trust_badges[], before_after[], backgrounds[]. Shape idem schema Zod.
    "assets" jsonb NOT NULL,
    -- Array de { agent, asset_type, provider, cost_usd? } — qual agente + provider
    -- contribuiu cada asset. Rastreabilidade + auditoria de custo por asset.
    "contributing_agents" jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Soma agent_trace.cost_usd + provider.cost_usd de todos os assets gerados.
    "cost_usd" numeric(10, 4) NOT NULL DEFAULT 0,
    -- Racional do Visual Director: paleta escolhida, tom, fallbacks de provider usados,
    -- assets omitidos por falha em ambos providers. Article IV enforcement: NUNCA vazio.
    "director_notes" text,
    -- Identifica orquestrador que assinou (ex.: 'landinglab-visual-director@opus-4.7').
    "generated_by_agent" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "landing_visual_assets_version_check"
        CHECK ("version" >= 1)
);
--> statement-breakpoint

COMMENT ON TABLE "landing_visual_assets" IS
    'Pacote visual por landing × versão. Produzido pelo Squad 3 (Visual & Brand Forge). Consumido por Squad 4 (Builder HTML). Assets language-agnostic na v1.';
COMMENT ON COLUMN "landing_visual_assets"."brand" IS
    'JSON de identidade de marca: name, tagline, logo_urls {full,mark,wordmark}, palette 5 cores, typography 2 fontes. Shape em packages/landinglab-visual/src/schema/visual-assets.ts.';
COMMENT ON COLUMN "landing_visual_assets"."assets" IS
    'JSON com URLs de todos os ativos visuais: hero {urls_by_size}, lifestyle[], icons[], trust_badges[], before_after[], backgrounds[].';
COMMENT ON COLUMN "landing_visual_assets"."contributing_agents" IS
    'Array JSON [{ agent, asset_type, provider, cost_usd? }] — rastreabilidade de qual agente + provider (freepik/higgsfield) gerou cada asset.';
COMMENT ON COLUMN "landing_visual_assets"."director_notes" IS
    'Racional do Visual Director: paleta escolhida, tom visual, fallbacks de provider usados (Freepik→Higgsfield), assets omitidos por falha. Article IV enforcement: nunca vazio, mínimo 10 chars.';
--> statement-breakpoint

-- Unique: garante que cada (landing, versão) é única.
-- Query padrão do Squad 4: "última versão do pacote visual pra landing X".
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_visual_assets_lp_version"
    ON "landing_visual_assets" USING btree
    ("landing_page_id", "version" DESC);
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- ROLLBACK (executar manualmente):
-- ═════════════════════════════════════════════════════════════════════════
--
-- DROP INDEX IF EXISTS "idx_landing_visual_assets_lp_version";
-- DROP TABLE IF EXISTS "landing_visual_assets";
--
-- Nota: rollback preserva landing_pir_documents (Squad 1) e landing_copy_decks
-- (Squad 2) intactos. Landings em generation_mode='autopilot' que já rodaram
-- Squad 3 perdem os pacotes visuais, mas PIR + Copy Deck permanecem — Squad 3
-- pode re-rodar após rollback+forward.

-- Migration 0068 — Adiciona `'translate'` ao CHECK de landing_generation_runs.squad
--
-- Referências:
--   - Story: docs/stories/skeleton-mode/SM-3.4.api-translate.story.md
--   - PRD:   docs/prd/skeleton-mode.md (FR-20, FR-21) — tradução pós-criação
--   - Pre-req: 0066_skeleton_mode_landing_pages.sql (adicionou 'skeleton_*')
--
-- Escopo: expandir CHECK constraint pra permitir squad='translate' registrado
-- pela rota POST /api/skeleton/:id/translate (SM-3.4). Necessário pro painel
-- Generation Progress mostrar histórico de traduções.
--
-- Zero risco:
--   - Additive-only. Rows existentes já usam valores válidos que permanecem
--     na lista.
--   - Padrão idêntico à migration 0066 (drop CHECK + re-add com novo valor).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Expandir CHECK constraint incluindo 'translate'
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "landing_generation_runs"
    DROP CONSTRAINT IF EXISTS "landing_generation_runs_squad_check";
--> statement-breakpoint

ALTER TABLE "landing_generation_runs"
    ADD CONSTRAINT "landing_generation_runs_squad_check"
    CHECK ("squad" IN (
        'product_research', 'copy', 'visual', 'build', 'deploy',
        'skeleton_extractor', 'brand_extractor', 'skeleton_composer',
        'translate'
    ));
--> statement-breakpoint

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- ROLLBACK (executar manualmente se necessário):
-- ═════════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--
-- -- IMPORTANTE: antes de reverter, deletar rows com squad='translate':
-- --   DELETE FROM landing_generation_runs WHERE squad = 'translate';
--
-- ALTER TABLE landing_generation_runs
--   DROP CONSTRAINT IF EXISTS landing_generation_runs_squad_check;
-- ALTER TABLE landing_generation_runs
--   ADD CONSTRAINT landing_generation_runs_squad_check
--   CHECK (squad IN (
--       'product_research', 'copy', 'visual', 'build', 'deploy',
--       'skeleton_extractor', 'brand_extractor', 'skeleton_composer'
--   ));
--
-- COMMIT;

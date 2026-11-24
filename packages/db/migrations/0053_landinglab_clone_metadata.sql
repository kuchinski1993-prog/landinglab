-- 0053 — Landing clone metadata (Fase 5.A completar).
--
-- Contexto: Fase 5.A introduziu generation_mode='cloned' (migration 0052)
-- e persistia source_url. Faltava telemetria completa do clone: quando foi
-- clonado, quantos assets baixaram, quantos falharam, qual plataforma, etc.
--
-- Uso: aba Clone no EditWorkspace (Task #13) mostra esses dados; badge
-- visual (Task #18) usa clone_source_host pra "Clonada de vigoraxi.com".
--
-- Estratégia: 2 colunas novas em landing_pages.
--   - cloned_at: timestamp do clone bem sucedido (NULL pra não-clonadas)
--   - clone_metadata: JSONB com stats (bytes, assets_ok, assets_failed,
--     images_count, latency_ms, source_platform)

BEGIN;

ALTER TABLE "landing_pages"
    ADD COLUMN IF NOT EXISTS "cloned_at" timestamp with time zone,
    ADD COLUMN IF NOT EXISTS "clone_metadata" jsonb;

-- Index leve pra queries "quais landings foram clonadas neste mês"
-- (usado por analytics no futuro). Partial index só nas clonadas.
CREATE INDEX IF NOT EXISTS "landing_pages_cloned_at_idx"
    ON "landing_pages" ("cloned_at" DESC)
    WHERE "cloned_at" IS NOT NULL;

COMMIT;

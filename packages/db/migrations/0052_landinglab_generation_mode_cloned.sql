-- 0052 — Landing generation_mode: adiciona 'cloned' (Fase 5.A).
--
-- Contexto: Fase 5.A introduz Squad 0 (Landing Cloner) que clona landings
-- externas via Playwright. Rows criadas por esse fluxo têm
-- generation_mode='cloned' — precisa ser aceito pelo CHECK constraint.
--
-- Reversível: drop + recria constraint sem 'cloned'.

BEGIN;

ALTER TABLE "landing_pages"
    DROP CONSTRAINT IF EXISTS "landing_pages_generation_mode_check";

ALTER TABLE "landing_pages"
    ADD CONSTRAINT "landing_pages_generation_mode_check"
    CHECK ("generation_mode" IN ('manual', 'autopilot', 'cloned'));

COMMIT;

-- Migration 0073 — Fase 9E.1 (Clone Source Preservation)
--
-- UNIQUE constraint parcial pra garantir 1 snapshot 'clone-initial'
-- por landing_page_id. Suporta ON CONFLICT DO NOTHING no INSERT
-- idempotente do clone processor.
--
-- Semântica:
-- - Cada landing pode ter exatamente 1 snapshot com reason='clone-initial'.
-- - Retry do clone job (BullMQ attempts) NÃO cria snapshots duplicados.
-- - Snapshot preservado permanece imutável mesmo se retry regerar HTML diferente.
-- - Nenhuma restrição pra outros valores de reason (apply-bundle full pipeline etc)
--   — comportamento atual preservado.
--
-- Rollback: DROP INDEX.
-- Zero mudança em dados existentes (0 snapshots com reason='clone-initial' hoje).

CREATE UNIQUE INDEX IF NOT EXISTS idx_landing_html_snapshots_clone_initial_unique
  ON landing_html_snapshots (landing_page_id)
  WHERE reason = 'clone-initial';

-- ROLLBACK:
-- DROP INDEX IF EXISTS idx_landing_html_snapshots_clone_initial_unique;

-- Migration 0072 — Fase 9A do Landing Lab Stabilization Roadmap.
--
-- Adiciona data_fingerprint em landing_html_snapshots pra medir idempotência
-- real do render: se 2 jobs consecutivos têm o MESMO fingerprint (dados
-- canônicos idênticos) e produzem sha256_after DIFERENTE, é evidência de
-- não-determinismo no worker.
--
-- Coluna nullable — landings antigas não têm fingerprint retroativo. OK.
-- Sem cascade delete (herda comportamento da tabela).

ALTER TABLE landing_html_snapshots
  ADD COLUMN IF NOT EXISTS data_fingerprint text;

-- Índice pra query rápida "último snapshot desta landing com fingerprint X":
CREATE INDEX IF NOT EXISTS idx_landing_html_snapshots_landing_fingerprint
  ON landing_html_snapshots (landing_page_id, data_fingerprint, created_at DESC)
  WHERE data_fingerprint IS NOT NULL;

-- ROLLBACK:
-- DROP INDEX IF EXISTS idx_landing_html_snapshots_landing_fingerprint;
-- ALTER TABLE landing_html_snapshots DROP COLUMN IF EXISTS data_fingerprint;

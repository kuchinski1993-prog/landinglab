-- Migration 0071 — landing_html_snapshots (Fase 7 do Stabilization Roadmap).
--
-- Histórico automático de mutações em landing_pages.html_body pra permitir
-- rollback interno (sem edição manual no banco).
--
-- Complementa a proteção da Fase 6 (html-safety): quando safeApplyHtmlMutation
-- valida com sucesso, o caller pode persistir o snapshot aqui pra auditoria +
-- restore.
--
-- Retenção: sem TTL fixo por padrão. Ferramenta administrativa futura pode
-- limpar snapshots >90 dias / >10 por landing. Zero cascade delete — sobrevive
-- a delete da landing (audit history).

CREATE TABLE IF NOT EXISTS landing_html_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Não FK CASCADE — snapshot sobrevive a delete de landing (audit)
  -- Referencia sem constraint pra permitir cleanup de landings sem perder histórico
  landing_page_id uuid NOT NULL,

  -- Contexto da mutação
  reason       text NOT NULL,
  actor        text NOT NULL, -- ex: 'worker/apply-bundle:job-123', 'api/edit-html'

  -- HTML capturado ANTES da mutação (pra rollback)
  html_body    text NOT NULL,
  bytes        integer NOT NULL,
  sha256       text NOT NULL,

  -- Resultado da mutação (successful writes) — pra correlacionar com bytes_after
  bytes_after  integer,
  sha256_after text,

  -- Warnings emitidos pelo html-safety (não-bloqueantes)
  warnings     jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Índice pra listar snapshots por landing (ordem desc = mais recentes primeiro)
CREATE INDEX IF NOT EXISTS idx_landing_html_snapshots_landing
  ON landing_html_snapshots (landing_page_id, created_at DESC);

-- Índice pra dedup (mesma landing + mesmo sha256 = mesmo estado)
CREATE INDEX IF NOT EXISTS idx_landing_html_snapshots_sha
  ON landing_html_snapshots (landing_page_id, sha256);

-- ROLLBACK (executar manualmente se necessário):
-- DROP INDEX IF EXISTS idx_landing_html_snapshots_landing;
-- DROP INDEX IF EXISTS idx_landing_html_snapshots_sha;
-- DROP TABLE IF EXISTS landing_html_snapshots;

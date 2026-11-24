-- Migration 0088: VSL Hosting G3 — backend núcleo (F1a, 2026-10-07)
--
-- Deltas sobre 0086_vsl_baseline + 0087_vsl_rls:
--   1. vsl_page_import_jobs — import G3 assíncrono (upload → job → worker com lease/fencing)
--   2. vsl_video_assets — agenda do scan de reconciliação Stream (backoff, sem reprocessar failed)
--   3. vsl_video_upload_intents — SHA-256 do arquivo inteiro opcional + hash por amostragem
--   4. blackshop_domains — resultado da última verificação ("Verificar agora")
--   5. Releases imutáveis no banco (trigger bloqueia UPDATE/DELETE em vsl_project_releases/vsl_step_releases)
--   6. Índices de analytics por período (vsl_events/vsl_watch_sessions)
--   7. RLS deny-all na tabela nova
--
-- Totalmente idempotente (IF NOT EXISTS, CREATE OR REPLACE, guards em pg_constraint/pg_trigger).
-- Sem BEGIN/COMMIT: quem aplica controla a transação. Fora do _journal.json (SQL manual).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 0088_vsl_g3_backend.sql
-- Requer 0086 e 0087 aplicadas. Rollback: 0088_vsl_g3_backend.rollback.sql

-- Guardrail (mesmo de 0087): RLS deny-all exige role com BYPASSRLS para o backend.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'VSL 0088 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Jobs de import G3
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vsl_page_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES vsl_pages(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  kind text NOT NULL,
  source_key text NOT NULL,
  source_bytes bigint NOT NULL,
  source_sha256 text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued',
  stage text NOT NULL DEFAULT 'queued',
  progress smallint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  lease_token uuid,
  lease_until timestamptz,
  run_after timestamptz NOT NULL DEFAULT now(),
  revision_id uuid REFERENCES vsl_page_revisions(id) ON DELETE RESTRICT,
  reused boolean NOT NULL DEFAULT false,
  report jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT vsl_page_import_jobs_idempotency_unique UNIQUE (page_id, idempotency_key),
  CONSTRAINT vsl_page_import_jobs_key_check CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT vsl_page_import_jobs_kind_check CHECK (kind IN ('html','zip')),
  CONSTRAINT vsl_page_import_jobs_state_check CHECK (state IN ('queued','running','needs_resolution','succeeded','failed')),
  CONSTRAINT vsl_page_import_jobs_progress_check CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT vsl_page_import_jobs_attempts_check CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10),
  CONSTRAINT vsl_page_import_jobs_bytes_check CHECK (source_bytes > 0),
  CONSTRAINT vsl_page_import_jobs_sha_check CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vsl_page_import_jobs_lease_check CHECK ((state = 'running') = (lease_token IS NOT NULL)),
  CONSTRAINT vsl_page_import_jobs_result_check CHECK (state <> 'succeeded' OR revision_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS vsl_page_import_jobs_claim_idx
  ON vsl_page_import_jobs (run_after, created_at) WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS vsl_page_import_jobs_page_idx ON vsl_page_import_jobs (page_id, created_at DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Scan de reconciliação Stream (G3)
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE vsl_video_assets ADD COLUMN IF NOT EXISTS reconcile_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE vsl_video_assets ADD COLUMN IF NOT EXISTS next_reconcile_at timestamptz;
ALTER TABLE vsl_video_assets ADD COLUMN IF NOT EXISTS last_webhook_at timestamptz;
CREATE INDEX IF NOT EXISTS vsl_video_assets_reconcile_idx
  ON vsl_video_assets (next_reconcile_at NULLS FIRST, updated_at) WHERE status IN ('uploading','processing');

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Identidade do upload sem exigir SHA-256 do arquivo inteiro no browser
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE vsl_video_upload_intents ALTER COLUMN source_sha256 DROP NOT NULL;
ALTER TABLE vsl_video_upload_intents ADD COLUMN IF NOT EXISTS sample_sha256 text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vsl_video_upload_intents'::regclass AND conname = 'vsl_video_upload_intents_sample_check'
  ) THEN
    ALTER TABLE vsl_video_upload_intents ADD CONSTRAINT vsl_video_upload_intents_sample_check
      CHECK (sample_sha256 IS NULL OR sample_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS vsl_video_upload_intents_sample_idx
  ON vsl_video_upload_intents (declared_bytes, sample_sha256) WHERE sample_sha256 IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Verificação de domínio
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE blackshop_domains ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
ALTER TABLE blackshop_domains ADD COLUMN IF NOT EXISTS last_check jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. Releases imutáveis
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION vsl_block_release_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VSL releases are immutable (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'vsl_project_releases'::regclass AND tgname = 'vsl_project_releases_immutable'
  ) THEN
    CREATE TRIGGER vsl_project_releases_immutable BEFORE UPDATE OR DELETE ON vsl_project_releases
      FOR EACH ROW EXECUTE FUNCTION vsl_block_release_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'vsl_step_releases'::regclass AND tgname = 'vsl_step_releases_immutable'
  ) THEN
    CREATE TRIGGER vsl_step_releases_immutable BEFORE UPDATE OR DELETE ON vsl_step_releases
      FOR EACH ROW EXECUTE FUNCTION vsl_block_release_mutation();
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 6. Analytics por período
-- ═════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS vsl_events_project_received_idx
  ON vsl_events (project_id, received_at) INCLUDE (step_id, event_name, session_id);
CREATE INDEX IF NOT EXISTS vsl_watch_sessions_project_updated_idx
  ON vsl_watch_sessions (project_id, updated_at) INCLUDE (step_id, watched_seconds, watched_percentage);

-- ═════════════════════════════════════════════════════════════════════════
-- 7. RLS deny-all (padrão 0087)
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.vsl_page_import_jobs ENABLE ROW LEVEL SECURITY;

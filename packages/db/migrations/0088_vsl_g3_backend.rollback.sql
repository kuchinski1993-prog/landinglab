-- Rollback 0088_vsl_g3_backend (somente dev/staging; em produção avaliar antes).
-- Idempotente. Apaga a tabela de jobs de import (histórico de importações G3).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 0088_vsl_g3_backend.rollback.sql

DROP INDEX IF EXISTS vsl_watch_sessions_project_updated_idx;
DROP INDEX IF EXISTS vsl_events_project_received_idx;

DROP TRIGGER IF EXISTS vsl_step_releases_immutable ON vsl_step_releases;
DROP TRIGGER IF EXISTS vsl_project_releases_immutable ON vsl_project_releases;
DROP FUNCTION IF EXISTS vsl_block_release_mutation();

ALTER TABLE blackshop_domains DROP COLUMN IF EXISTS last_check;
ALTER TABLE blackshop_domains DROP COLUMN IF EXISTS last_checked_at;

DROP INDEX IF EXISTS vsl_video_upload_intents_sample_idx;
ALTER TABLE vsl_video_upload_intents DROP CONSTRAINT IF EXISTS vsl_video_upload_intents_sample_check;
ALTER TABLE vsl_video_upload_intents DROP COLUMN IF EXISTS sample_sha256;
-- NOT NULL só volta se nenhum intent foi criado sem SHA-256 (senão a coluna fica nullable).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vsl_video_upload_intents WHERE source_sha256 IS NULL) THEN
    ALTER TABLE vsl_video_upload_intents ALTER COLUMN source_sha256 SET NOT NULL;
  ELSE
    RAISE NOTICE 'vsl_video_upload_intents.source_sha256 mantida nullable: existem intents sem SHA-256';
  END IF;
END $$;

DROP INDEX IF EXISTS vsl_video_assets_reconcile_idx;
ALTER TABLE vsl_video_assets DROP COLUMN IF EXISTS last_webhook_at;
ALTER TABLE vsl_video_assets DROP COLUMN IF EXISTS next_reconcile_at;
ALTER TABLE vsl_video_assets DROP COLUMN IF EXISTS reconcile_attempts;

DROP TABLE IF EXISTS vsl_page_import_jobs;

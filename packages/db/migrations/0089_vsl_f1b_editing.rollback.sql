-- Rollback 0089_vsl_f1b_editing (somente dev/staging; em produção avaliar antes).
-- Idempotente. Apaga traduções e jobs de revisão derivada (edição de textos / tradução);
-- as revisões já criadas por eles continuam (são revisões normais de página).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 0089_vsl_f1b_editing.rollback.sql

DROP TABLE IF EXISTS vsl_page_translation_units;
DROP TABLE IF EXISTS vsl_page_translations;

-- Jobs que não são import não cabem no shape da 0088 (source_* NOT NULL).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vsl_page_import_jobs' AND column_name = 'operation') THEN
    DELETE FROM vsl_page_import_jobs WHERE operation <> 'import';
  END IF;
END $$;
ALTER TABLE vsl_page_import_jobs DROP CONSTRAINT IF EXISTS vsl_page_import_jobs_derived_check;
ALTER TABLE vsl_page_import_jobs DROP CONSTRAINT IF EXISTS vsl_page_import_jobs_source_check;
ALTER TABLE vsl_page_import_jobs DROP CONSTRAINT IF EXISTS vsl_page_import_jobs_operation_check;
ALTER TABLE vsl_page_import_jobs ALTER COLUMN source_sha256 SET NOT NULL;
ALTER TABLE vsl_page_import_jobs ALTER COLUMN source_bytes SET NOT NULL;
ALTER TABLE vsl_page_import_jobs ALTER COLUMN source_key SET NOT NULL;
ALTER TABLE vsl_page_import_jobs DROP COLUMN IF EXISTS payload;
ALTER TABLE vsl_page_import_jobs DROP COLUMN IF EXISTS base_revision_id;
ALTER TABLE vsl_page_import_jobs DROP COLUMN IF EXISTS operation;

ALTER TABLE vsl_page_revisions DROP COLUMN IF EXISTS storage_deleted_at;

ALTER TABLE vsl_pages DROP CONSTRAINT IF EXISTS vsl_pages_locale_check;
ALTER TABLE vsl_pages DROP COLUMN IF EXISTS locale;

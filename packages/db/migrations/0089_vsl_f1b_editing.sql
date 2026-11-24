-- Migration 0089: VSL Hosting G3 — funções de edição (F1b, 2026-10-07)
--
-- Deltas sobre 0086 + 0087 + 0088:
--   1. vsl_pages.locale — idioma da página (páginas geradas por tradução)
--   2. vsl_page_revisions.storage_deleted_at — marca do GC (prefixo removido do storage)
--   3. vsl_page_import_jobs — mesmo pipeline de jobs para revisões derivadas:
--      operation = import | text_edit | translation_apply (+ base_revision_id, payload);
--      source_* só obrigatórios no import
--   4. vsl_page_translations + vsl_page_translation_units — tradução de página (Claude) com revisão
--   5. RLS deny-all nas tabelas novas
--
-- Totalmente idempotente (IF NOT EXISTS, guards em pg_constraint). Sem BEGIN/COMMIT.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 0089_vsl_f1b_editing.sql
-- Requer 0086, 0087 e 0088 aplicadas. Rollback: 0089_vsl_f1b_editing.rollback.sql

-- Guardrail (mesmo de 0087/0088): RLS deny-all exige role com BYPASSRLS para o backend.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'VSL 0089 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Idioma da página
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE vsl_pages ADD COLUMN IF NOT EXISTS locale text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'vsl_pages'::regclass AND conname = 'vsl_pages_locale_check') THEN
    ALTER TABLE vsl_pages ADD CONSTRAINT vsl_pages_locale_check CHECK (locale IS NULL OR locale ~ '^[a-z]{2}(-[A-Z]{2})?$');
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. GC de revisões órfãs
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE vsl_page_revisions ADD COLUMN IF NOT EXISTS storage_deleted_at timestamptz;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Jobs de revisão derivada (edição de textos / aplicar tradução)
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE vsl_page_import_jobs ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'import';
ALTER TABLE vsl_page_import_jobs ADD COLUMN IF NOT EXISTS base_revision_id uuid REFERENCES vsl_page_revisions(id) ON DELETE RESTRICT;
ALTER TABLE vsl_page_import_jobs ADD COLUMN IF NOT EXISTS payload jsonb;
ALTER TABLE vsl_page_import_jobs ALTER COLUMN source_key DROP NOT NULL;
ALTER TABLE vsl_page_import_jobs ALTER COLUMN source_bytes DROP NOT NULL;
ALTER TABLE vsl_page_import_jobs ALTER COLUMN source_sha256 DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'vsl_page_import_jobs'::regclass AND conname = 'vsl_page_import_jobs_operation_check') THEN
    ALTER TABLE vsl_page_import_jobs ADD CONSTRAINT vsl_page_import_jobs_operation_check
      CHECK (operation IN ('import','text_edit','translation_apply'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'vsl_page_import_jobs'::regclass AND conname = 'vsl_page_import_jobs_source_check') THEN
    ALTER TABLE vsl_page_import_jobs ADD CONSTRAINT vsl_page_import_jobs_source_check
      CHECK (operation <> 'import' OR (source_key IS NOT NULL AND source_bytes IS NOT NULL AND source_sha256 IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'vsl_page_import_jobs'::regclass AND conname = 'vsl_page_import_jobs_derived_check') THEN
    ALTER TABLE vsl_page_import_jobs ADD CONSTRAINT vsl_page_import_jobs_derived_check
      CHECK (operation = 'import' OR (base_revision_id IS NOT NULL AND payload IS NOT NULL));
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Tradução de páginas
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vsl_page_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL DEFAULT 'l0i',
  page_id uuid NOT NULL REFERENCES vsl_pages(id) ON DELETE RESTRICT,
  source_revision_id uuid NOT NULL REFERENCES vsl_page_revisions(id) ON DELETE RESTRICT,
  source_locale text,
  target_locale text NOT NULL,
  status text NOT NULL DEFAULT 'extracting',
  progress smallint NOT NULL DEFAULT 0,
  source_chars integer NOT NULL DEFAULT 0,
  units_total integer NOT NULL DEFAULT 0,
  provider text,
  model text,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  lease_token uuid,
  lease_until timestamptz,
  run_after timestamptz NOT NULL DEFAULT now(),
  apply_job_id uuid REFERENCES vsl_page_import_jobs(id) ON DELETE RESTRICT,
  target_page_id uuid REFERENCES vsl_pages(id) ON DELETE RESTRICT,
  target_revision_id uuid REFERENCES vsl_page_revisions(id) ON DELETE RESTRICT,
  link_step_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT vsl_page_translations_status_check CHECK (status IN ('extracting','translating','review','applying','done','failed')),
  CONSTRAINT vsl_page_translations_locale_check CHECK (target_locale IN ('it','en','es','pt','fr','de','nl','pl')),
  CONSTRAINT vsl_page_translations_progress_check CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT vsl_page_translations_attempts_check CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10),
  CONSTRAINT vsl_page_translations_lease_check CHECK (lease_token IS NULL OR status = 'translating'),
  CONSTRAINT vsl_page_translations_done_check CHECK (status <> 'done' OR (target_page_id IS NOT NULL AND target_revision_id IS NOT NULL)),
  CONSTRAINT vsl_page_translations_steps_check CHECK (jsonb_typeof(link_step_ids) = 'array')
);
CREATE INDEX IF NOT EXISTS vsl_page_translations_claim_idx
  ON vsl_page_translations (run_after, created_at) WHERE status = 'translating';
CREATE INDEX IF NOT EXISTS vsl_page_translations_page_idx ON vsl_page_translations (page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vsl_page_translation_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  translation_id uuid NOT NULL REFERENCES vsl_page_translations(id) ON DELETE CASCADE,
  position integer NOT NULL,
  block_id text NOT NULL,
  kind text NOT NULL,
  label text NOT NULL,
  context text NOT NULL DEFAULT '',
  source text NOT NULL,
  translated text,
  status text NOT NULL DEFAULT 'pending',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_page_translation_units_block_unique UNIQUE (translation_id, block_id),
  CONSTRAINT vsl_page_translation_units_position_unique UNIQUE (translation_id, position),
  CONSTRAINT vsl_page_translation_units_kind_check CHECK (kind IN ('text','attribute','title','meta','script-string')),
  CONSTRAINT vsl_page_translation_units_status_check CHECK (status IN ('pending','edited','approved'))
);

-- ═════════════════════════════════════════════════════════════════════════
-- 5. RLS deny-all (padrão 0087)
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.vsl_page_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_page_translation_units ENABLE ROW LEVEL SECURITY;

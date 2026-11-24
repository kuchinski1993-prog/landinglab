-- Rollback da 0086_vsl_baseline.sql — SOMENTE BANCOS DE DEV/CI DESCARTÁVEIS.
--
-- EM PRODUÇÃO NÃO SE FAZ ROLLBACK DESTA BASELINE. As tabelas VSL de produção
-- são mantidas (decisão do plano: nenhum DROP de tabela; remoção de código
-- legacy é etapa posterior). Este arquivo existe para limpar bancos locais.
--
-- Apaga TODAS as tabelas VSL/foundation (e os dados delas), as funções/triggers
-- VSL e as 4 colunas VSL de landing_pages. Não toca em landing_domains.
--
-- Trava: exige confirmação explícita na mesma sessão/transação:
--   SET vsl.allow_baseline_rollback = 'on';
--   \i 0086_vsl_baseline.rollback.sql
-- Rodar antes o rollback da RLS (0087_vsl_rls.rollback.sql) é opcional:
-- DROP TABLE já remove o estado de RLS.

DO $$
BEGIN
  IF current_setting('vsl.allow_baseline_rollback', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'VSL baseline rollback aborted: dev-only. SET vsl.allow_baseline_rollback = ''on'' to confirm.';
  END IF;
END $$;

-- Ponte, analytics e publicação G3
DROP TABLE IF EXISTS vsl_legacy_project_links;
DROP TABLE IF EXISTS vsl_watch_sessions;
DROP TABLE IF EXISTS vsl_events;
DROP TABLE IF EXISTS vsl_publication_events;
DROP TABLE IF EXISTS vsl_public_routes;
DROP TABLE IF EXISTS vsl_step_releases;
ALTER TABLE IF EXISTS vsl_projects DROP CONSTRAINT IF EXISTS vsl_projects_active_release_fk;
DROP TABLE IF EXISTS vsl_project_releases;

-- Assets e funis G3
DROP TABLE IF EXISTS vsl_asset_references;
ALTER TABLE IF EXISTS vsl_steps DROP CONSTRAINT IF EXISTS vsl_steps_page_revision_fk;
ALTER TABLE IF EXISTS vsl_steps DROP CONSTRAINT IF EXISTS vsl_steps_video_asset_fk;
DROP TABLE IF EXISTS vsl_video_upload_intents;
DROP TABLE IF EXISTS vsl_video_assets;
ALTER TABLE IF EXISTS vsl_pages DROP CONSTRAINT IF EXISTS vsl_pages_current_revision_owner;
DROP TABLE IF EXISTS vsl_page_revisions;
DROP TABLE IF EXISTS vsl_pages;
DROP TABLE IF EXISTS vsl_steps;
DROP TABLE IF EXISTS vsl_projects;

-- Domínios/bindings G2
DROP TABLE IF EXISTS vsl_domain_publication_events;
DROP TABLE IF EXISTS vsl_domain_bindings;
DROP TABLE IF EXISTS blackshop_domains;

-- Tradução e variantes G2
DROP TABLE IF EXISTS vsl_translation_reviews;
DROP TABLE IF EXISTS vsl_translation_units;
DROP TABLE IF EXISTS vsl_translation_batches;
DROP TABLE IF EXISTS vsl_asset_gc_jobs;
DROP TABLE IF EXISTS vsl_variant_asset_refs;
DROP TABLE IF EXISTS vsl_shared_assets;
DROP TABLE IF EXISTS vsl_variant_manifest_overrides;
DROP TABLE IF EXISTS vsl_variants;

-- Domínio/publicação G1
DROP TABLE IF EXISTS vsl_cache_invalidations;
DROP TABLE IF EXISTS vsl_publications;
DROP TABLE IF EXISTS vsl_domains;

-- Stream uploads G1
DROP TRIGGER IF EXISTS vsl_video_revision_guard ON landing_page_versions;
DROP TRIGGER IF EXISTS vsl_video_draft_guard ON landing_hosting_settings;
DROP TABLE IF EXISTS vsl_video_references;
DROP TABLE IF EXISTS vsl_stream_events;
DROP TABLE IF EXISTS vsl_video_uploads;

-- Import lifecycle G1
DROP TABLE IF EXISTS vsl_preview_sessions;
DROP TABLE IF EXISTS vsl_releases;
ALTER TABLE IF EXISTS vsl_imports DROP CONSTRAINT IF EXISTS vsl_imports_active_attempt_id_vsl_import_attempts_id_fk;
DROP TABLE IF EXISTS vsl_import_attempts;
DROP TABLE IF EXISTS vsl_imports;

-- Foundation
DROP TABLE IF EXISTS landing_hosting_settings;
DROP TABLE IF EXISTS landing_video_assets;
DROP TRIGGER IF EXISTS landing_pages_published_version_owner ON landing_pages;
ALTER TABLE landing_pages DROP CONSTRAINT IF EXISTS landing_pages_published_version_fk;
DROP TABLE IF EXISTS landing_page_versions;
DROP INDEX IF EXISTS idx_landing_pages_hosted_family_locale;
ALTER TABLE landing_pages
  DROP COLUMN IF EXISTS published_version_id,
  DROP COLUMN IF EXISTS locale,
  DROP COLUMN IF EXISTS family_id,
  DROP COLUMN IF EXISTS content_mode;
DROP TABLE IF EXISTS landing_page_families;

DROP FUNCTION IF EXISTS vsl_video_owner_guard();
DROP FUNCTION IF EXISTS vsl_video_revision_guard();
DROP FUNCTION IF EXISTS vsl_video_draft_guard();
DROP FUNCTION IF EXISTS vsl_video_lock_guard();
DROP FUNCTION IF EXISTS vsl_asset_reference_guard();
DROP FUNCTION IF EXISTS vsl_variant_source_guard();
DROP FUNCTION IF EXISTS enforce_vsl_release_import_owner();
DROP FUNCTION IF EXISTS enforce_vsl_resource_owner();
DROP FUNCTION IF EXISTS enforce_landing_published_version_owner();

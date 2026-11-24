-- Migration 0087: RLS deny-all nas 39 tabelas VSL/foundation (F0, 2026-10-07)
--
-- Mesmo padrão de 0076_enable_rls_landing_tables.sql: RLS ligado SEM policies
-- = deny-all para anon/authenticated (PostgREST/Realtime); o acesso do backend
-- é via DATABASE_URL com role superuser/BYPASSRLS e não é afetado.
--
-- Produção: JÁ APLICADO em 2026-10-07 (hotfix `vsl_enable_rls_hotfix`). Este
-- arquivo é idempotente ( ENABLE ROW LEVEL SECURITY em tabela já com RLS é no-op)
-- e serve para bancos dev/CI/staging, depois da 0086_vsl_baseline.sql.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 0087_vsl_rls.sql
-- Sem BEGIN/COMMIT no arquivo: quem aplica controla a transação.
--
-- Rollback: 0087_vsl_rls.rollback.sql

-- Guardrail: aborta se o role que aplica não for superuser nem tiver BYPASSRLS.
-- Sem isso, API/worker/storefront VSL perderiam acesso às próprias tabelas.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'RLS rollout aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

-- 39 tabelas criadas por 0086_vsl_baseline.sql (mesma ordem do arquivo).
ALTER TABLE public.landing_page_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_page_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_hosting_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_video_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_import_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_preview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_video_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_stream_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_video_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_cache_invalidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_variant_manifest_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_shared_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_variant_asset_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_asset_gc_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_translation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_translation_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_translation_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blackshop_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_domain_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_domain_publication_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_page_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_video_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_video_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_asset_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_project_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_step_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_public_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_publication_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_watch_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vsl_legacy_project_links ENABLE ROW LEVEL SECURITY;

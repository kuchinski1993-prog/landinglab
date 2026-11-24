-- Rollback: desliga RLS nas 39 tabelas VSL/foundation (par de 0087_vsl_rls.sql)
--
-- Uso: SOMENTE se o RLS quebrar acesso legítimo (ex.: um caminho novo via
-- anon/authenticated). Reverte para o estado sem RLS — as tabelas voltam a
-- ficar expostas via PostgREST conforme GRANTs. Não aplicar como rotina e
-- NUNCA em produção sem aprovação explícita do owner.

ALTER TABLE IF EXISTS public.landing_page_families DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.landing_page_versions DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.landing_hosting_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.landing_video_assets DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_imports DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_import_attempts DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_releases DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_preview_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_video_uploads DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_stream_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_video_references DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_domains DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_publications DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_cache_invalidations DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_variants DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_variant_manifest_overrides DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_shared_assets DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_variant_asset_refs DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_asset_gc_jobs DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_translation_batches DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_translation_units DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_translation_reviews DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.blackshop_domains DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_domain_bindings DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_domain_publication_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_projects DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_steps DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_pages DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_page_revisions DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_video_assets DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_video_upload_intents DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_asset_references DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_project_releases DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_step_releases DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_public_routes DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_publication_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_watch_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vsl_legacy_project_links DISABLE ROW LEVEL SECURITY;

-- Rollback: disable RLS on landing_* tables (par de 0076_enable_rls_landing_tables.sql)
--
-- Uso: aplicar SOMENTE se um deploy no-op quebrar acesso via anon/authenticated
-- em produção. Reverte para estado pré-migration (sem RLS, acesso público
-- restrito apenas por GRANT/REVOKE). Não deve ser aplicado como rotina.

BEGIN;

ALTER TABLE public.landing_pages            DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_variants         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_domains          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_domain_bindings  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_pixels           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_orders           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_settings         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_bundle_offers    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_html_snapshots   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_pir_documents    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_generation_runs  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_copy_decks       DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_visual_assets    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_deployments      DISABLE ROW LEVEL SECURITY;

COMMIT;

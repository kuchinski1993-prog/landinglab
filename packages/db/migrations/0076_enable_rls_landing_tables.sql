-- Migration: enable RLS on all landing_* tables (2026-09-29)
--
-- Contexto: auditoria confirmou que TODAS as 14 tabelas landing_* não têm RLS.
-- Todos os acessos são via Drizzle+DATABASE_URL (superuser, bypassa RLS).
-- Nenhum acesso via anon/authenticated key (PostgREST) nas tabelas landing_*.
-- Enabling RLS with no policies = deny-all para roles anon/authenticated;
-- superuser/BYPASSRLS continua tendo acesso irrestrito.
--
-- Segurança: se algum caminho novo (Edge Function, PostgREST, Realtime) passar
-- a acessar essas tabelas via anon/authenticated, o acesso será bloqueado
-- por default — force-fixando o desenvolvedor a adicionar policy explícita.
--
-- Rollback: 0076_enable_rls_landing_tables.rollback.sql

BEGIN;

-- Guardrail: aborta se o role que está aplicando não for superuser nem tiver
-- BYPASSRLS. Sem isso, o próprio worker perderia acesso imediatamente após
-- o COMMIT — deadlock em produção.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'RLS rollout aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

-- 14 tabelas landing_* (verificado contra packages/db/src/schema-landinglab-*.ts em 2026-09-29):
--   schema-landinglab-core.ts: landing_pages, landing_variants, landing_domains,
--     landing_domain_bindings, landing_pixels, landing_orders, landing_settings,
--     landing_bundle_offers, landing_html_snapshots
--   schema-landinglab.ts: landing_pir_documents, landing_generation_runs,
--     landing_copy_decks, landing_visual_assets, landing_deployments
ALTER TABLE public.landing_pages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_variants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_domains          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_domain_bindings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_pixels           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_orders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_bundle_offers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_html_snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_pir_documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_generation_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_copy_decks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_visual_assets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_deployments      ENABLE ROW LEVEL SECURITY;

COMMIT;

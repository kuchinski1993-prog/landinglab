-- Migration 0092: RLS deny-all nas tabelas public que ainda estavam abertas (Épico 0 · 0.9)
--
-- Achado (2026-11-01): 47 tabelas do schema public tinham RLS desligado e o
-- papel `anon` com SELECT/INSERT/UPDATE/DELETE/TRUNCATE (grants padrão do
-- Supabase). A chave anon fica embutida no JS do backoffice
-- (NEXT_PUBLIC_SUPABASE_ANON_KEY, usada só para upload no Storage), então
-- qualquer pessoa com ela conseguia ler/alterar pedidos, e-mails de clientes,
-- notas, leads e a tabela de credenciais pela API REST do Supabase.
--
-- Correção: mesmo padrão da 0087 (VSL) — RLS habilitado SEM policies = nega
-- tudo para anon/authenticated. O backend (api, worker, rotas server do
-- backoffice) conecta como `postgres`, que tem BYPASSRLS, então nada muda para
-- ele. O upload de imagens usa o schema `storage` (policies próprias), que esta
-- migration não toca.
--
-- Não altera dados nem estrutura. Rollback: 0092_rls_deny_all_public.rollback.sql

-- Guardrail: sem BYPASSRLS o próprio backend ficaria bloqueado.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0092 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

ALTER TABLE IF EXISTS "ai_usage_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "claude_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "collection_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "collections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "conversation_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "customer_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "disputes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "email_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "factory_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "font_substitution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "inbound_ai_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "inbound_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "inbound_automation_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "inbound_classification_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "inbound_email_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "inbound_emails" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "inbound_macros" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "job_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "pages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "price_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "product_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "product_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "product_pairings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "product_questions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "product_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "product_variants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "publish_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "refund_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "refund_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "shipment_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "size_guides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "skeleton_source_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "skeleton_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "stores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "theme_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "theme_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "theme_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "themes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "tracking_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "tracking_pixels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "tracking_sessions" ENABLE ROW LEVEL SECURITY;

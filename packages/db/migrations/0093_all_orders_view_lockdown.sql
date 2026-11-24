-- Migration 0093: fecha a view all_orders para anon/authenticated (Épico 0 · 0.9)
--
-- Depois da 0092 o Supabase ainda apontava ERROR security_definer_view:
-- a view all_orders (0045, UNION de orders + landing_orders) roda com a
-- permissão do dono, então a chave anon lia pedidos por ela mesmo com RLS nas
-- tabelas. Nenhum código usa a view (só a 0045 a cita). O backend (postgres,
-- BYPASSRLS) continua lendo normalmente.
--
-- Rollback: 0093_all_orders_view_lockdown.rollback.sql

ALTER VIEW IF EXISTS "all_orders" SET (security_invoker = true);
REVOKE ALL ON "all_orders" FROM anon, authenticated;

-- Rollback da 0093: devolve o comportamento anterior (reabre a view para anon).
-- ATENÇÃO: reexpõe pedidos pela chave anon. Use só em emergência.

ALTER VIEW IF EXISTS "all_orders" RESET (security_invoker);
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "all_orders" TO anon, authenticated;

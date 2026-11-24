-- Portal Fase 2 — Fulfillment estrutural em orders.
--
-- Aditiva. Hoje tracking_number e carrier vivem só em orders.raw (jsonb do
-- webhook orders/paid). Portal Track precisa disso estruturado para render
-- rápido, e para o webhook orders/updated / fulfillments/updated atualizar
-- em coluna, não em JSON.
--
-- Sem defaults: uma linha antiga pode continuar NULL — só populamos quando
-- o webhook novo chegar. Portal sabe lidar com NULL (HonestEmptyState).

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "fulfillment_status" text;
--> statement-breakpoint

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "carrier" text;
--> statement-breakpoint

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "tracking_number" text;
--> statement-breakpoint

-- Índice barato para lookups por tracking_number (support flow futuro
-- "meu rastreio é X, cadê meu pedido?").
CREATE INDEX IF NOT EXISTS "idx_orders_tracking_number"
  ON "orders" ("store_id", "tracking_number")
  WHERE "tracking_number" IS NOT NULL;
--> statement-breakpoint

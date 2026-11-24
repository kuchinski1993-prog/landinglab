-- Portal Fase 2 — Eventos de shipment.
--
-- Aditiva. Alimenta a timeline honesta do Track Order no portal público.
-- Cada linha é um evento reportado pelo webhook Shopify (orders/updated,
-- fulfillments/updated). Nunca inflamos progresso: se não temos evento,
-- a UI mostra estado honesto (packages sem tracking = "processing").
--
-- Idempotência: unique index parcial em (store_id, order_id, event_at,
-- status) evita duplicar quando o webhook reenvia. Sem FK "hard" para
-- orders (soft ref via order_id) — mesmo padrão de refund_tickets vs
-- inbound_emails; desacopla o ciclo de vida.

CREATE TABLE IF NOT EXISTS "shipment_events" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'default',
  "order_id" text NOT NULL,
  -- Status normalizado: 'confirmed' | 'processing' | 'fulfilled' |
  -- 'in_transit_hub' | 'out_for_delivery' | 'delivered' | 'exception' |
  -- outros valores futuros (schema não força enum para permitir extensão).
  "status" text,
  -- Descrição curta livre do evento (o que o carrier reportou).
  "description" text,
  -- Local do evento (cidade, país, "International Hub", etc.). Nullable.
  "location" text,
  -- Timestamp do evento reportado pelo carrier/Shopify. Usado para ordenar
  -- a timeline. Se ausente na origem, cai em created_at.
  "event_at" timestamp with time zone NOT NULL DEFAULT now(),
  "raw" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Feed principal do timeline (mais antigo primeiro para renderizar do
-- Order Confirmed até Your Door).
CREATE INDEX IF NOT EXISTS "idx_shipment_events_feed"
  ON "shipment_events" ("store_id", "order_id", "event_at");
--> statement-breakpoint

-- Idempotência do webhook: mesmo (store, order, event_at, status) só entra
-- uma vez. Como event_at pode variar milissegundos, usamos a tupla completa
-- como discriminador do evento — reenviar exatamente o mesmo evento é NO-OP.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_shipment_events_dedupe"
  ON "shipment_events" ("store_id", "order_id", "event_at", "status")
  WHERE "status" IS NOT NULL;
--> statement-breakpoint

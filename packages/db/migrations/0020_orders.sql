-- TrustShield Fase B1 — persistência de pedidos pagos da Shopify.
-- O webhook ORDERS_PAID já recebe o payload e o envia ao Meta CAPI; aqui ele
-- passa a também gravar o pedido. Habilita: valores €/£ nos KPIs, contexto rico
-- para o agente IA do refund, elegibilidade automática e métricas reais de
-- chargeback. Idempotente por id (id = id do pedido na Shopify, como texto).
-- Source-of-truth completo fica em `raw` (jsonb do payload original) — campos
-- desnormalizados (total, currency, etc.) são para query/index.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL DEFAULT 'default',
	"order_number" text,
	"total_price" numeric(12, 2),
	"currency" text,
	"customer_email" text,
	"customer_phone" text,
	"financial_status" text,
	"line_items" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"raw" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"shopify_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_store" ON "orders" ("store_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_customer_email" ON "orders" ("customer_email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_shopify_created" ON "orders" ("shopify_created_at");

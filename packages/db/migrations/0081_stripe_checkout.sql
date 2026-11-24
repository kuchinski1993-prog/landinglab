-- Migration 0081: checkout Stripe da LandingLab (Story 15.3)
--
-- Spec: docs/architecture/landinglab-stripe-checkout.md §4.4, §4.5, §6.1
--
-- landing_checkout_sessions: snapshot imutável do carrinho criado no clique
--   do CTA (oferta + preço + atribuição). O checkout nunca confia em preço do
--   browser: tudo é recalculado a partir deste snapshot + frete do mercado.
-- landing_orders: colunas do pedido Stripe (frete, subtotal, mercado, sessão).
--   Numeração por país: IT-10001, IT-10002… (sequence única).
-- landing_pages: nome/imagem exibidos no checkout (sem a marca de origem).
-- stripe_accounts.payment_method_domains: domínios já registrados na conta
--   para Apple Pay / Google Pay.
--
-- RLS habilitado sem policies (padrão 0076).
-- Rollback: 0081_stripe_checkout.rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "landing_checkout_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token" text NOT NULL,
  "store_id" text NOT NULL DEFAULT 'l0i',
  "landing_page_id" uuid NOT NULL REFERENCES "landing_pages"("id"),
  "market_id" uuid NOT NULL REFERENCES "landing_markets"("id"),
  "bundle_offer_id" uuid REFERENCES "landing_bundle_offers"("id") ON DELETE SET NULL,
  "host" text NOT NULL,
  "locale" text NOT NULL,
  "currency" text NOT NULL,
  "items_snapshot" jsonb NOT NULL,
  "subtotal_minor" bigint NOT NULL,
  "shipping_method" text,
  "shipping_minor" bigint,
  "amount_minor" bigint,
  "attribution" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "customer" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "stripe_account_id" uuid REFERENCES "stripe_accounts"("id") ON DELETE SET NULL,
  "payment_intent_id" text,
  "meta_event_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "failed_attempts" integer NOT NULL DEFAULT 0,
  "order_id" uuid,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "landing_checkout_sessions_status_check" CHECK ("status" IN ('open', 'paid', 'expired')),
  CONSTRAINT "landing_checkout_sessions_shipping_check"
    CHECK ("shipping_method" IS NULL OR "shipping_method" IN ('free', 'express')),
  CONSTRAINT "landing_checkout_sessions_subtotal_check" CHECK ("subtotal_minor" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_checkout_sessions_token"
  ON "landing_checkout_sessions" ("token");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_checkout_sessions_pi"
  ON "landing_checkout_sessions" ("payment_intent_id") WHERE "payment_intent_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_landing_checkout_sessions_landing"
  ON "landing_checkout_sessions" ("landing_page_id", "created_at");

CREATE SEQUENCE IF NOT EXISTS "landing_order_number_seq" START WITH 10001;

ALTER TABLE "landing_orders"
  ADD COLUMN IF NOT EXISTS "checkout_session_id" uuid REFERENCES "landing_checkout_sessions"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "market_id" uuid REFERENCES "landing_markets"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "locale" text,
  ADD COLUMN IF NOT EXISTS "shipping_method" text,
  ADD COLUMN IF NOT EXISTS "shipping_minor" bigint,
  ADD COLUMN IF NOT EXISTS "subtotal_minor" bigint,
  ADD COLUMN IF NOT EXISTS "amount_minor" bigint,
  ADD COLUMN IF NOT EXISTS "refunded_minor" bigint NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_orders_checkout_session"
  ON "landing_orders" ("checkout_session_id") WHERE "checkout_session_id" IS NOT NULL;

ALTER TABLE "landing_pages"
  ADD COLUMN IF NOT EXISTS "checkout_product_name" text,
  ADD COLUMN IF NOT EXISTS "checkout_product_image" text;

ALTER TABLE "stripe_accounts"
  ADD COLUMN IF NOT EXISTS "payment_method_domains" text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE "landing_checkout_sessions" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE landing_checkout_sessions
  IS 'Checkout Stripe (Story 15.3): snapshot do carrinho criado no CTA; preço sempre recalculado no servidor.';
COMMENT ON COLUMN landing_pages.checkout_product_name
  IS 'Nome do produto exibido no checkout/pedido (sem a marca da loja de origem).';

COMMIT;

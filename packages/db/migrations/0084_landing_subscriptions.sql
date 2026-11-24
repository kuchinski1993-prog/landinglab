-- Migration 0084: assinaturas Stripe da LandingLab (Story 15.6)
--
-- Spec: docs/architecture/landinglab-stripe-checkout.md D5, §4.5, §6.4, P3
-- Decisões do owner (2026-10-06): assinatura pelo checkbox Subscribe & Save da
-- landing + intervalo por landing; desconto em todas as faturas; frete só na
-- 1ª fatura; retentativas pela Stripe; Purchase só na 1ª fatura.
--
-- landing_pages: subs_interval (day|week|month|year) + subs_interval_count
--   (1–12). Usados só quando checkout_provider = 'stripe' (Shopify continua
--   pelo selling plan).
-- landing_subscriptions: assinatura criada pelo checkout Stripe. Presa à conta
--   onde nasceu (FK RESTRICT: a conta não pode ser apagada com assinaturas).
--   Estado da assinatura vive aqui; pedidos mantêm o status da 15.4.
-- stripe_offer_prices: cache de Product/Price recorrente por conta e valores
--   (oferta, valor, moeda, intervalo). Valores novos → Price novo; o antigo
--   não é alterado.
-- landing_orders: order_kind (one_time | subscription_initial |
--   subscription_renewal), stripe_subscription_id / subscription_id e
--   stripe_invoice_id (UNIQUE parcial — idempotência da renovação).
-- landing_checkout_sessions: billing (snapshot da assinatura; NULL = avulso)
--   e stripe_subscription_id (Subscription criada no submit do checkout).
-- landing_order_events.type: + subscription_started, subscription_renewed,
--   subscription_payment_failed, subscription_canceled.
--
-- RLS habilitado sem policies (padrão 0076). store_id padrão 'l0i'.
-- NÃO aplicada automaticamente — o owner aplica antes do merge.
-- Rollback: 0084_landing_subscriptions.rollback.sql

BEGIN;

ALTER TABLE "landing_pages"
  ADD COLUMN IF NOT EXISTS "subs_interval" text,
  ADD COLUMN IF NOT EXISTS "subs_interval_count" integer NOT NULL DEFAULT 1;

ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_subs_interval_check";
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_subs_interval_check"
  CHECK ("subs_interval" IS NULL OR "subs_interval" IN ('day', 'week', 'month', 'year'));
ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_subs_interval_count_check";
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_subs_interval_count_check"
  CHECK ("subs_interval_count" BETWEEN 1 AND 12);

CREATE TABLE IF NOT EXISTS "landing_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'l0i',
  "landing_page_id" uuid NOT NULL REFERENCES "landing_pages"("id"),
  "first_order_id" uuid REFERENCES "landing_orders"("id") ON DELETE SET NULL,
  "stripe_account_id" uuid NOT NULL REFERENCES "stripe_accounts"("id") ON DELETE RESTRICT,
  "stripe_customer_id" text NOT NULL,
  "stripe_subscription_id" text NOT NULL,
  "stripe_price_id" text NOT NULL,
  "bundle_offer_id" uuid,
  "status" text NOT NULL DEFAULT 'active',
  "interval" text NOT NULL,
  "interval_count" integer NOT NULL DEFAULT 1,
  "unit_amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "customer_email" text NOT NULL,
  "customer_name" text,
  "locale" text,
  "market_id" uuid,
  "current_period_end" timestamptz,
  "renewals_count" integer NOT NULL DEFAULT 0,
  "failed_payments" integer NOT NULL DEFAULT 0,
  "cancel_reason" text,
  "canceled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "landing_subscriptions_status_check" CHECK ("status" IN (
    'incomplete', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete_expired'
  )),
  CONSTRAINT "landing_subscriptions_interval_check" CHECK ("interval" IN ('day', 'week', 'month', 'year'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_subscriptions_stripe"
  ON "landing_subscriptions" ("stripe_account_id", "stripe_subscription_id");
CREATE INDEX IF NOT EXISTS "idx_landing_subscriptions_status"
  ON "landing_subscriptions" ("store_id", "status");
CREATE INDEX IF NOT EXISTS "idx_landing_subscriptions_email"
  ON "landing_subscriptions" ("customer_email");
CREATE INDEX IF NOT EXISTS "idx_landing_subscriptions_account"
  ON "landing_subscriptions" ("stripe_account_id");

CREATE TABLE IF NOT EXISTS "stripe_offer_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'l0i',
  "stripe_account_id" uuid NOT NULL REFERENCES "stripe_accounts"("id") ON DELETE CASCADE,
  "bundle_offer_id" uuid NOT NULL REFERENCES "landing_bundle_offers"("id") ON DELETE CASCADE,
  "stripe_product_id" text NOT NULL,
  "stripe_price_id" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "interval" text NOT NULL,
  "interval_count" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_stripe_offer_prices_key"
  ON "stripe_offer_prices" ("stripe_account_id", "bundle_offer_id", "amount_minor", "currency", "interval", "interval_count");

ALTER TABLE "landing_orders"
  ADD COLUMN IF NOT EXISTS "stripe_subscription_id" text,
  ADD COLUMN IF NOT EXISTS "subscription_id" uuid REFERENCES "landing_subscriptions"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "stripe_invoice_id" text,
  ADD COLUMN IF NOT EXISTS "order_kind" text NOT NULL DEFAULT 'one_time';

ALTER TABLE "landing_orders" DROP CONSTRAINT IF EXISTS "landing_orders_order_kind_check";
ALTER TABLE "landing_orders" ADD CONSTRAINT "landing_orders_order_kind_check"
  CHECK ("order_kind" IN ('one_time', 'subscription_initial', 'subscription_renewal'));

CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_orders_stripe_invoice"
  ON "landing_orders" ("stripe_invoice_id") WHERE "stripe_invoice_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_landing_orders_subscription"
  ON "landing_orders" ("subscription_id", "created_at") WHERE "subscription_id" IS NOT NULL;

ALTER TABLE "landing_checkout_sessions"
  ADD COLUMN IF NOT EXISTS "billing" jsonb,
  ADD COLUMN IF NOT EXISTS "stripe_subscription_id" text;

CREATE INDEX IF NOT EXISTS "idx_landing_checkout_sessions_subscription"
  ON "landing_checkout_sessions" ("stripe_subscription_id") WHERE "stripe_subscription_id" IS NOT NULL;

ALTER TABLE "landing_order_events" DROP CONSTRAINT IF EXISTS "landing_order_events_type_check";
ALTER TABLE "landing_order_events" ADD CONSTRAINT "landing_order_events_type_check" CHECK ("type" IN (
  'paid', 'preparing', 'shipped', 'refunded', 'email_sent', 'email_failed', 'note',
  'subscription_started', 'subscription_renewed', 'subscription_payment_failed', 'subscription_canceled'
));

ALTER TABLE "landing_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stripe_offer_prices" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE landing_subscriptions
  IS 'Assinaturas do checkout Stripe da LandingLab (Story 15.6). Presa à conta de origem (FK RESTRICT). Gestão/cancelamento só pelo Customer Portal.';
COMMENT ON TABLE stripe_offer_prices
  IS 'Cache de Product/Price recorrente por conta Stripe e oferta (Story 15.6). Valores diferentes = Price novo.';
COMMENT ON COLUMN landing_orders.order_kind
  IS 'one_time (15.3) | subscription_initial (1ª fatura) | subscription_renewal (invoice.paid subscription_cycle).';
COMMENT ON COLUMN landing_orders.stripe_invoice_id
  IS 'Fatura Stripe que originou o pedido de assinatura. UNIQUE parcial = idempotência da renovação.';
COMMENT ON COLUMN landing_checkout_sessions.billing
  IS 'Snapshot da assinatura: {mode:''subscription'', interval, intervalCount, unitAmountMinor, discountPercent}. NULL = compra avulsa.';

COMMIT;

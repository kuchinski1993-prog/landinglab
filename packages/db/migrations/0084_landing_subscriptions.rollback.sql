-- Rollback da migration 0084 (Story 15.6).
-- Atenção: apaga as assinaturas da LandingLab, o cache de Product/Price e os
-- vínculos dos pedidos com faturas/assinaturas (as assinaturas continuam na
-- Stripe). Eventos de timeline de assinatura são removidos para caber no
-- CHECK anterior. Pedidos de renovação continuam existindo como pedidos.

BEGIN;

DELETE FROM "landing_order_events" WHERE "type" IN (
  'subscription_started', 'subscription_renewed', 'subscription_payment_failed', 'subscription_canceled'
);
ALTER TABLE "landing_order_events" DROP CONSTRAINT IF EXISTS "landing_order_events_type_check";
ALTER TABLE "landing_order_events" ADD CONSTRAINT "landing_order_events_type_check" CHECK ("type" IN (
  'paid', 'preparing', 'shipped', 'refunded', 'email_sent', 'email_failed', 'note'
));

DROP INDEX IF EXISTS "idx_landing_checkout_sessions_subscription";
ALTER TABLE "landing_checkout_sessions"
  DROP COLUMN IF EXISTS "stripe_subscription_id",
  DROP COLUMN IF EXISTS "billing";

DROP INDEX IF EXISTS "idx_landing_orders_subscription";
DROP INDEX IF EXISTS "idx_landing_orders_stripe_invoice";
ALTER TABLE "landing_orders" DROP CONSTRAINT IF EXISTS "landing_orders_order_kind_check";
ALTER TABLE "landing_orders"
  DROP COLUMN IF EXISTS "order_kind",
  DROP COLUMN IF EXISTS "stripe_invoice_id",
  DROP COLUMN IF EXISTS "subscription_id",
  DROP COLUMN IF EXISTS "stripe_subscription_id";

DROP TABLE IF EXISTS "stripe_offer_prices";
DROP TABLE IF EXISTS "landing_subscriptions";

ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_subs_interval_count_check";
ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_subs_interval_check";
ALTER TABLE "landing_pages"
  DROP COLUMN IF EXISTS "subs_interval_count",
  DROP COLUMN IF EXISTS "subs_interval";

COMMIT;

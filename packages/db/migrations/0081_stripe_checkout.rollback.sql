-- Rollback da migration 0081 (Story 15.3).
-- Atenção: apaga sessões de checkout e as colunas de pedido Stripe.

BEGIN;

ALTER TABLE "stripe_accounts" DROP COLUMN IF EXISTS "payment_method_domains";
ALTER TABLE "landing_pages"
  DROP COLUMN IF EXISTS "checkout_product_image",
  DROP COLUMN IF EXISTS "checkout_product_name";

DROP INDEX IF EXISTS "idx_landing_orders_checkout_session";
ALTER TABLE "landing_orders"
  DROP COLUMN IF EXISTS "refunded_minor",
  DROP COLUMN IF EXISTS "amount_minor",
  DROP COLUMN IF EXISTS "subtotal_minor",
  DROP COLUMN IF EXISTS "shipping_minor",
  DROP COLUMN IF EXISTS "shipping_method",
  DROP COLUMN IF EXISTS "locale",
  DROP COLUMN IF EXISTS "market_id",
  DROP COLUMN IF EXISTS "checkout_session_id";

DROP SEQUENCE IF EXISTS "landing_order_number_seq";
DROP TABLE IF EXISTS "landing_checkout_sessions";

COMMIT;

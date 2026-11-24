-- Rollback da migration 0082 (Story 15.4).
-- Atenção: apaga a timeline dos pedidos, dados de rastreio (URL/datas) e a
-- identidade jurídica dos mercados. Pedidos em 'preparing' voltam a 'paid'
-- para caber no CHECK anterior.

BEGIN;

ALTER TABLE "landing_markets" DROP COLUMN IF EXISTS "seller_info";

DROP INDEX IF EXISTS "idx_landing_orders_paid_waiting";

UPDATE "landing_orders" SET "status" = 'paid' WHERE "status" = 'preparing';
ALTER TABLE "landing_orders" DROP CONSTRAINT IF EXISTS "landing_orders_status_check";
ALTER TABLE "landing_orders" ADD CONSTRAINT "landing_orders_status_check"
  CHECK ("status" IN (
    'pending', 'paid', 'shipped', 'delivered',
    'refunded', 'cancelled', 'chargeback', 'failed'
  ));

ALTER TABLE "landing_orders"
  DROP COLUMN IF EXISTS "preparing_at",
  DROP COLUMN IF EXISTS "shipped_at",
  DROP COLUMN IF EXISTS "tracking_url";

DROP TABLE IF EXISTS "landing_order_events";

COMMIT;

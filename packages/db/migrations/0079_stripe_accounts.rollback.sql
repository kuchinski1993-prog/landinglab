-- Rollback da migration 0079 (Story 15.1).
-- Atenção: apaga contas Stripe cadastradas e o histórico de webhooks.

BEGIN;

DROP INDEX IF EXISTS "idx_landing_orders_stripe_account_paid";

ALTER TABLE "landing_orders"
  DROP COLUMN IF EXISTS "paid_at",
  DROP COLUMN IF EXISTS "settlement_currency",
  DROP COLUMN IF EXISTS "amount_settlement_minor",
  DROP COLUMN IF EXISTS "stripe_account_id";

DROP TABLE IF EXISTS "stripe_webhook_events";
DROP TABLE IF EXISTS "stripe_accounts";

COMMIT;

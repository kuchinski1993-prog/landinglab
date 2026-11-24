-- Rollback da migration 0080 (Story 15.2).
-- Atenção: apaga os mercados cadastrados e a escolha de provider das landings.

BEGIN;

DROP INDEX IF EXISTS "idx_landing_pages_market";
ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_checkout_provider_check";
ALTER TABLE "landing_pages"
  DROP COLUMN IF EXISTS "checkout_provider",
  DROP COLUMN IF EXISTS "market_id";

DROP TABLE IF EXISTS "landing_markets";

COMMIT;

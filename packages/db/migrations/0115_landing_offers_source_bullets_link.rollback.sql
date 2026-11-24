-- Rollback da migration 0115 (Story 25.1).
-- Remove o modo das ofertas, os bullets e o link por oferta. Atenção: bullets e
-- links editados no editor se perdem; as landings em modo 'system' voltam a usar
-- as ofertas da página. Faça o rollback do código da 25.1 ANTES deste SQL.

BEGIN;

ALTER TABLE "landing_bundle_offers" DROP COLUMN IF EXISTS "checkout_url";
ALTER TABLE "landing_bundle_offers" DROP COLUMN IF EXISTS "bullets";

ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_offers_source_check";
ALTER TABLE "landing_pages" DROP COLUMN IF EXISTS "offers_source";

COMMIT;

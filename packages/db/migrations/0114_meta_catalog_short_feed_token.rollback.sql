-- Rollback da migration 0114 (Story 24.6).
-- Volta o CHECK para >= 43. Atenção: catálogos com token curto (32) ganham um
-- token novo de 64 caracteres para caber na regra antiga, e o link antigo deles
-- passa a responder 404 (atualize o feed no Commerce Manager).

BEGIN;

UPDATE "meta_catalogs"
   SET "feed_token" = md5(random()::text || id::text) || md5(random()::text || clock_timestamp()::text)
 WHERE char_length("feed_token") < 43;

ALTER TABLE "meta_catalogs" DROP CONSTRAINT IF EXISTS "meta_catalogs_feed_token_check";
ALTER TABLE "meta_catalogs"
  ADD CONSTRAINT "meta_catalogs_feed_token_check" CHECK (char_length("feed_token") >= 43);

COMMIT;

-- Migration 0114: link curto do feed do catálogo Meta (Story 24.6, Epic 24)
--
-- A 0111 exigia feed_token com >= 43 caracteres (32 bytes em base64url). A 24.6
-- passa a gerar tokens de 16 bytes em hex (32 caracteres, 128 bits) para o link
-- curto /feeds/:token.csv|.xml. Esta migration só troca o CHECK para >= 32.
-- Nenhum dado muda: os tokens atuais (43) seguem válidos e respondendo.
--
-- Depende da 0111. Idempotente (DROP IF EXISTS + ADD). Aplicada em produção em
-- 2026-11-21 com aprovação do owner. Rollback: 0114_meta_catalog_short_feed_token.rollback.sql.

BEGIN;

ALTER TABLE "meta_catalogs" DROP CONSTRAINT IF EXISTS "meta_catalogs_feed_token_check";
ALTER TABLE "meta_catalogs"
  ADD CONSTRAINT "meta_catalogs_feed_token_check" CHECK (char_length("feed_token") >= 32);

COMMIT;

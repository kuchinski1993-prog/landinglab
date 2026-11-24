-- Rollback da migration 0113 (Story 24.4).
-- Apaga o histórico e as colunas de conexão/sincronização. Os tokens no Vault
-- (meta_catalog.{id}.token) NÃO são apagados por este SQL: remova-os pela tela
-- (Configurações → Remover conexão) ANTES do rollback, ou apague as chaves do
-- Vault à mão. Itens, mídia e feed seguem funcionando (o feed não depende da 0113).

BEGIN;

DROP TABLE IF EXISTS "meta_catalog_sync_events";

DROP INDEX IF EXISTS "idx_meta_catalog_items_sync";
ALTER TABLE "meta_catalog_items"
  DROP CONSTRAINT IF EXISTS "meta_catalog_items_sync_status_check",
  DROP COLUMN IF EXISTS "sync_status",
  DROP COLUMN IF EXISTS "sync_error",
  DROP COLUMN IF EXISTS "synced_at";

ALTER TABLE "meta_catalogs"
  DROP CONSTRAINT IF EXISTS "meta_catalogs_connection_status_check",
  DROP CONSTRAINT IF EXISTS "meta_catalogs_meta_catalog_id_check",
  DROP CONSTRAINT IF EXISTS "meta_catalogs_pending_deletes_check",
  DROP COLUMN IF EXISTS "meta_catalog_id",
  DROP COLUMN IF EXISTS "meta_token_key",
  DROP COLUMN IF EXISTS "meta_catalog_name",
  DROP COLUMN IF EXISTS "connection_status",
  DROP COLUMN IF EXISTS "connection_error",
  DROP COLUMN IF EXISTS "connection_checked_at",
  DROP COLUMN IF EXISTS "push_enabled",
  DROP COLUMN IF EXISTS "pending_deletes",
  DROP COLUMN IF EXISTS "last_synced_at";

COMMIT;

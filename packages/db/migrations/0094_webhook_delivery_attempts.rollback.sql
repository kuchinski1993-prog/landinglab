-- Rollback da 0094: remove o índice único de Purchase e a tabela de tentativas.
-- ATENÇÃO: apaga o histórico de tentativas do webhook Shopify. A API da Story
-- 0.2 continua gravando pedidos sem a tabela (o registro da tentativa roda num
-- SAVEPOINT e só loga erro), mas perde o registro de falhas usado pelo script
-- de reprocessamento — prefira reverter a API antes.

BEGIN;
DROP INDEX IF EXISTS "uq_tracking_events_purchase_event_id";
DROP TABLE IF EXISTS "webhook_delivery_attempts";
COMMIT;

-- Rollback da migration 0083 (Story 15.5).
-- Atenção: apaga todas as conversas, mensagens e metadados de anexos do
-- suporte LandingLab. Os arquivos no bucket (landing-support/...) não são
-- removidos por este script.

BEGIN;

DROP TABLE IF EXISTS "landing_support_attachments";
DROP TABLE IF EXISTS "landing_support_messages";
DROP TABLE IF EXISTS "landing_support_threads";

COMMIT;

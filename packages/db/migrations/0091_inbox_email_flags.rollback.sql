-- Rollback da migration 0091 (Story 16.1).
-- Apaga só as marcações de lido / estrela / arquivado. Nenhum e-mail é afetado.

BEGIN;

DROP TABLE IF EXISTS "inbox_email_flags";

COMMIT;

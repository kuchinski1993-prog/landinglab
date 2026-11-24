-- Rollback da 0097 (Story 18.3): remove o ledger de jobs duráveis.
-- ATENÇÃO: apaga o histórico de tentativas (job_runs). Os jobs no BullMQ não são
-- afetados. Volte o código antes: sem a tabela, o wrapper (durableProcessor) e o
-- enqueue durável (enqueueDurable) só logam job_ledger_write_failed e seguem
-- (o job roda/enfileira), mas perdem histórico e deduplicação.
-- Remove também products.mirror_uncertain_at (o publish deixa de esperar a indexação).

BEGIN;
DROP TABLE IF EXISTS "job_runs";
ALTER TABLE IF EXISTS "products" DROP COLUMN IF EXISTS "mirror_uncertain_at";
COMMIT;

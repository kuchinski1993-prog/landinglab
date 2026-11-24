-- Rollback da 0095 (Épico 0 · story 0.7): remove a guarda de câmbio.
-- ATENÇÃO: apaga o histórico de câmbio e os relatórios de sync. A taxa vigente
-- (price_rules.exchange_rate) não é afetada. Antes de rodar, volte o código
-- para a versão sem a guarda (o worker/api atuais leem estas tabelas).

DROP TABLE IF EXISTS "fx_sync_runs";
DROP TABLE IF EXISTS "fx_rate_history";
ALTER TABLE "price_rules" DROP COLUMN IF EXISTS "rate_locked";

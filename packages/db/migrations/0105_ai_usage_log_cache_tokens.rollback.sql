-- Rollback da 0105 (Story 21.6b): remove as contagens de tokens de cache do ai_usage_log.
--
-- O custo já gravado (cost_estimate_usd) não muda — só se perde o detalhe de quantos tokens foram
-- escritos/lidos do cache. A API continua funcionando sem as colunas (grava sem elas).

BEGIN;
ALTER TABLE "ai_usage_log" DROP COLUMN IF EXISTS "cache_read_input_tokens";
ALTER TABLE "ai_usage_log" DROP COLUMN IF EXISTS "cache_creation_input_tokens";
COMMIT;

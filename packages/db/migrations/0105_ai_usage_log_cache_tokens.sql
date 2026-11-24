-- Migration 0105: tokens de prompt caching no ai_usage_log (Story 21.6b)
--
-- O assistente passa a usar prompt caching da Anthropic (cache de 5 minutos). O provedor devolve
-- três contagens de entrada separadas: input_tokens (sem cache), cache_creation_input_tokens
-- (escritos no cache, cobrados a 1,25× a entrada) e cache_read_input_tokens (lidos do cache, 0,1×).
-- tokens_input continua sendo a entrada SEM cache; as duas colunas novas guardam as de cache.
-- cost_estimate_usd já vem calculado com as três tarifas (lib/assistant/pricing.ts).
--
-- Aditiva e idempotente (ADD COLUMN IF NOT EXISTS, DEFAULT 0 — linhas antigas e o editor de tema,
-- que não manda essas colunas, ficam com 0). Não depende da 0104.
-- Ordem de deploy: esta migration antes de ligar o assistente. Sem ela, a API grava o uso sem as
-- colunas de cache (o custo e o teto diário continuam corretos) — ver lib/assistant/usage.ts.
-- Rollback: 0105_ai_usage_log_cache_tokens.rollback.sql (descarta só as contagens de cache).

BEGIN;

ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "cache_creation_input_tokens" integer DEFAULT 0 NOT NULL;
ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "cache_read_input_tokens" integer DEFAULT 0 NOT NULL;

COMMIT;

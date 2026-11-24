-- Rollback da 0104 (Story 21.6): remove as tabelas do assistente de negócios.
--
-- ATENÇÃO: APAGA o histórico de conversas do assistente (assistant_conversations/messages) e a
-- configuração (teto diário, liga/desliga). O histórico é descartável por desenho (retenção de 90
-- dias); o custo já gasto continua em ai_usage_log (endpoint = 'assistant'), que esta migration
-- não alterou.
--
-- Volte o código antes (ou desligue com ASSISTANT_ENABLED=false): sem as tabelas, GET
-- /assistant/status responde { enabled: false, reason: 'unavailable' } e o chat responde 503.

BEGIN;
DROP TABLE IF EXISTS "assistant_messages";
DROP TABLE IF EXISTS "assistant_conversations";
DROP TABLE IF EXISTS "assistant_settings";
COMMIT;

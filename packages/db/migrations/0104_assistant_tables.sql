-- Migration 0104: assistente de negócios — conversas, mensagens e configuração (Story 21.6)
--
-- Numeração PROVISÓRIA: 0101–0103 ficam reservadas para a Story 22.1a (contas por e-mail). Se a
-- 22.1a entrar com outra numeração (ou depois desta), renumerar no merge — o arquivo não depende
-- de nenhuma migration posterior à 0044 (ai_usage_log, que NÃO é alterada aqui).
--
-- Tabelas:
--   assistant_conversations — uma conversa por usuário e loja (user_id + store_id do request; a API
--                             filtra SEMPRE pelos dois: id de outra pessoa/loja = 404).
--   assistant_messages      — pergunta (já mascarada por scrubPii) e resposta; nunca o resultado
--                             bruto das ferramentas (só nomes em tools_used). FK em cascata.
--   assistant_settings      — 1 linha (id = 1): liga/desliga e teto diário em USD (padrão 2,00).
--
-- Retenção: a API apaga, a cada POST /assistant/chat, as conversas do próprio usuário com
-- updated_at há mais de 90 dias (limpeza preguiçosa). Não há job.
--
-- RLS: nasce habilitado e SEM policies (deny-all para anon/authenticated), mesmo padrão da
-- 0096/0097/0100. O backend conecta como `postgres` (BYPASSRLS) — guardrail abaixo.
--
-- Ordem de deploy: esta migration → API (com ASSISTANT_ENABLED=false) → painel → ligar.
-- Idempotente (IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- Rollback: 0104_assistant_tables.rollback.sql (APAGA o histórico de conversas — descartável).

BEGIN;

-- Guardrail: sem BYPASSRLS o próprio backend ficaria bloqueado nas tabelas novas.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0104 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "assistant_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "store_id" text NOT NULL,
  "title" text NOT NULL DEFAULT 'Nova conversa',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "assistant_conversations_title_check" CHECK (char_length("title") <= 120)
);

CREATE INDEX IF NOT EXISTS "idx_assistant_conversations_user_store_updated"
  ON "assistant_conversations" ("user_id", "store_id", "updated_at" DESC);

CREATE TABLE IF NOT EXISTS "assistant_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" uuid NOT NULL REFERENCES "assistant_conversations"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "tools_used" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tokens_input" integer NOT NULL DEFAULT 0,
  "tokens_output" integer NOT NULL DEFAULT 0,
  "cost_usd" numeric(10,6) NOT NULL DEFAULT 0,
  "model" text,
  "prompt_version" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "assistant_messages_role_check" CHECK ("role" IN ('user', 'assistant'))
);

CREATE INDEX IF NOT EXISTS "idx_assistant_messages_conversation_created"
  ON "assistant_messages" ("conversation_id", "created_at");

CREATE TABLE IF NOT EXISTS "assistant_settings" (
  "id" smallint PRIMARY KEY DEFAULT 1,
  "enabled" boolean NOT NULL DEFAULT true,
  "daily_cap_usd" numeric(8,2) NOT NULL DEFAULT 2.00,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" text,
  CONSTRAINT "assistant_settings_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "assistant_settings_daily_cap_check" CHECK ("daily_cap_usd" >= 0)
);

ALTER TABLE "assistant_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_settings" ENABLE ROW LEVEL SECURITY;

-- Semente: a linha única de configuração (ligado, teto US$ 2,00). O interruptor de verdade no
-- deploy é a variável ASSISTANT_ENABLED=false na API.
INSERT INTO "assistant_settings" ("id", "enabled", "daily_cap_usd")
VALUES (1, true, 2.00)
ON CONFLICT ("id") DO NOTHING;

COMMIT;

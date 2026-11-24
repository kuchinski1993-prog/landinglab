-- TrustShield Fase 3 — captura de emails inbound.
-- Os emails são enviados pelo cliente para support@authenlondon.com (e aliases),
-- chegam via Cloudflare Email Routing, e um Cloudflare Email Worker (fora deste
-- escopo) faz POST para /webhooks/email/inbound da API. Esta tabela guarda o
-- payload puro para inspeção e para a Fase 4 (IA classifica spam vs. cliente
-- legítimo) e Fase 5 (resposta automática via Resend).
--
-- Tudo aditivo. `raw` (jsonb) é a fonte da verdade — colunas desnormalizadas
-- são só para query/index. PII em from/to/subject/body NUNCA deve ser logada;
-- armazenar aqui é o propósito da tabela, logar é outro contexto.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_emails" (
	"id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
	"store_id" text NOT NULL DEFAULT 'default',
	"message_id" text,
	"from_address" text NOT NULL,
	"from_name" text,
	"to_address" text NOT NULL,
	"subject" text,
	"text_body" text,
	"html_body" text,
	"headers" jsonb,
	"raw" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"spf_result" text,
	"dkim_result" text,
	"status" text NOT NULL DEFAULT 'received',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbound_emails_store_created" ON "inbound_emails" ("store_id", "created_at");
--> statement-breakpoint
-- Index parcial: só dedupe quando message_id existe. Sem o WHERE clauseo
-- Postgres trataria NULL = NULL como distinto (semântica normal), mas
-- ficar com NULLs no índice único é desperdício e gera linhas vazias no plano.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_inbound_emails_message_id" ON "inbound_emails" ("message_id") WHERE "message_id" IS NOT NULL;

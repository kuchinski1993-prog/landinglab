-- TrustShield Fase 4+5 — pipeline IA do inbound email.
-- Adiciona colunas em inbound_emails para classificação + verificação +
-- threading + associação a pedido/refund, e cria as 5 tabelas novas que
-- suportam o fluxo: threads, drafts (fila de aprovação operador),
-- feedback (sinal supervisionado para calibrar), ai_actions
-- (observabilidade de custo/latência), automation_config (chave mestra
-- liga/desliga + thresholds), e attachments (fotos do cliente).
--
-- Régua dura preservada: a IA classifica/responde/comunica, NUNCA decide
-- dinheiro. Auto-resposta começa DESLIGADA (automation_enabled=false) —
-- modo shadow para o dono validar precisão antes de virar a chavinha.
--
-- Migration AÇÃO ÚNICA, aditiva, idempotente (CREATE ... IF NOT EXISTS,
-- ADD COLUMN IF NOT EXISTS).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

-- ── Inbound emails: campos da Fase 4+5 ──────────────────────────────────
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "classification_confidence" numeric(4, 3);
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "classification_signals" jsonb;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "ai_provider" text;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "verification_state" text;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "thread_id" uuid;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "order_id" text;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "refund_ticket_id" uuid;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "escalated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "answered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "prefilter_reason" text;
--> statement-breakpoint
-- Decisão do pipeline (para shadow mode mostrar "o que TERIA acontecido").
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "proposed_action" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inbound_emails_status_category"
  ON "inbound_emails" ("store_id", "status", "category", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbound_emails_thread"
  ON "inbound_emails" ("thread_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbound_emails_from"
  ON "inbound_emails" ("store_id", "from_address");
--> statement-breakpoint

-- ── Threads de conversa ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "conversation_threads" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'default',
  "customer_email" text NOT NULL,
  "order_id" text,
  "verification_state" text NOT NULL DEFAULT 'unknown_sender',
  "status" text NOT NULL DEFAULT 'open',
  "category" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_threads_email"
  ON "conversation_threads" ("store_id", "customer_email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_threads_status"
  ON "conversation_threads" ("store_id", "status", "updated_at" DESC);
--> statement-breakpoint

-- ── Drafts da IA (fila de aprovação do operador) ───────────────────────
CREATE TABLE IF NOT EXISTS "inbound_email_drafts" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "inbound_email_id" uuid NOT NULL REFERENCES "inbound_emails"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "html_body" text NOT NULL,
  "text_body" text,
  "guard_passed" boolean NOT NULL DEFAULT true,
  "guard_reasons" jsonb,
  "ai_provider" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "approved_at" timestamp with time zone,
  "approved_by" text,
  "edited" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_drafts_inbound"
  ON "inbound_email_drafts" ("inbound_email_id", "created_at" DESC);
--> statement-breakpoint

-- ── Feedback supervisionado do operador ───────────────────────────────
-- Cada correção/reclassificação vira sinal para calibrar prompts/thresholds.
CREATE TABLE IF NOT EXISTS "inbound_classification_feedback" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "inbound_email_id" uuid NOT NULL REFERENCES "inbound_emails"("id") ON DELETE CASCADE,
  "ai_category" text,
  "ai_confidence" numeric(4, 3),
  "operator_category" text NOT NULL,
  "feedback_type" text NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedback_created"
  ON "inbound_classification_feedback" ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedback_type"
  ON "inbound_classification_feedback" ("feedback_type", "created_at" DESC);
--> statement-breakpoint

-- ── Observabilidade de ações da IA ────────────────────────────────────
-- Custo + latência por chamada. Permite alarmar daily_cost e calibrar.
CREATE TABLE IF NOT EXISTS "inbound_ai_actions" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "inbound_email_id" uuid NOT NULL REFERENCES "inbound_emails"("id") ON DELETE CASCADE,
  "function_name" text NOT NULL,
  "provider" text NOT NULL,
  "input_tokens" integer,
  "output_tokens" integer,
  "latency_ms" integer,
  "succeeded" boolean NOT NULL,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_actions_function"
  ON "inbound_ai_actions" ("function_name", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_actions_provider_created"
  ON "inbound_ai_actions" ("provider", "created_at" DESC);
--> statement-breakpoint

-- ── Configuração de automação (chave mestra + thresholds) ─────────────
CREATE TABLE IF NOT EXISTS "inbound_automation_config" (
  "store_id" text PRIMARY KEY NOT NULL,
  "auto_reply_confidence" numeric(4, 3) NOT NULL DEFAULT 0.85,
  "spam_confidence" numeric(4, 3) NOT NULL DEFAULT 0.85,
  "automation_enabled" boolean NOT NULL DEFAULT false,
  "auto_reply_categories" text[] NOT NULL DEFAULT ARRAY['policy_question', 'product_question_pre_purchase']::text[],
  "daily_cost_alert_usd" numeric(8, 2),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Seed da config default (single-store). Não toca se já existe.
INSERT INTO "inbound_automation_config" ("store_id") VALUES ('default')
  ON CONFLICT ("store_id") DO NOTHING;
--> statement-breakpoint

-- ── Anexos (fotos do cliente) ─────────────────────────────────────────
-- storage_key aponta para o objeto no Supabase Storage (bucket
-- "inbound-attachments"). Não armazenamos base64 no Postgres.
CREATE TABLE IF NOT EXISTS "inbound_attachments" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "inbound_email_id" uuid NOT NULL REFERENCES "inbound_emails"("id") ON DELETE CASCADE,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "storage_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attachments_inbound"
  ON "inbound_attachments" ("inbound_email_id", "created_at");

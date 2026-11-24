-- TrustShield Fase B2 (B) — colunas de classificação de intenção pela IA.
-- Pipeline: classifyIntent (mock OU anthropic) → grava ai_intent +
-- ai_intent_confidence + ai_provider + ai_analyzed_at no ticket.
-- Recommend/respond seguem mock por ora (fases C/D).
-- Migration aditiva, idempotente. NÃO altera dados existentes.

ALTER TABLE "refund_tickets"
  ADD COLUMN IF NOT EXISTS "ai_intent" text,
  ADD COLUMN IF NOT EXISTS "ai_intent_confidence" numeric(4, 3),
  ADD COLUMN IF NOT EXISTS "ai_provider" text,
  ADD COLUMN IF NOT EXISTS "ai_analyzed_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_refund_tickets_ai_intent"
  ON "refund_tickets" ("ai_intent");

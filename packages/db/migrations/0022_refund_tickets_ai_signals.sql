-- TrustShield Fase B2 (C) — output rico do recommendRefund.
-- Fase B persistia apenas ai_intent. Fase C precisa guardar signals (jsonb)
-- e reasoning (texto interno, NUNCA exposto ao cliente — o GET público
-- filtra refund_tickets.ai_*). Migration aditiva, idempotente.

ALTER TABLE "refund_tickets"
  ADD COLUMN IF NOT EXISTS "ai_signals" jsonb,
  ADD COLUMN IF NOT EXISTS "ai_reasoning" text;

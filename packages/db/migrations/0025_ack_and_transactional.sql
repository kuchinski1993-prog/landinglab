-- TrustShield Fase 1 — Ack garantido + allowlist transacional.
--
-- Aditiva, idempotente. Adiciona:
--   1. inbound_emails.acknowledgement_sent_at (timestamp) — lock lógico
--      pra idempotência do acuse-recebimento determinístico.
--   2. inbound_automation_config.acknowledgement_always_on (bool, default true)
--      — flag pra exceção do shadow (ack é comunicação segura, sempre envia).
--
-- Régua ética: ack não decide dinheiro; apenas confirma recebimento, pede
-- info se necessário, e escala pra humano. Silêncio é o que gera chargeback.

ALTER TABLE "inbound_emails"
  ADD COLUMN IF NOT EXISTS "acknowledgement_sent_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "inbound_automation_config"
  ADD COLUMN IF NOT EXISTS "acknowledgement_always_on" boolean NOT NULL DEFAULT true;
--> statement-breakpoint

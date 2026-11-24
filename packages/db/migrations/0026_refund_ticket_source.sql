-- TrustShield Fase 1 continuação — abertura de ticket automática a partir
-- do canal de email (analyze-inbound.processor cria ticket quando
-- category=refund_request).
--
-- Aditiva, idempotente. Adiciona rastreabilidade da origem:
--   1. refund_tickets.source (text) — 'storefront_form' (default retro-compat)
--      ou 'inbound_email' (aberto pelo pipeline inbound).
--   2. refund_tickets.source_inbound_email_id (uuid) — soft ref pro
--      inbound_emails.id que abriu o ticket. Nullable.
--   3. Índice em source_inbound_email_id (lookup reverso ao investigar).

ALTER TABLE "refund_tickets"
  ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint

ALTER TABLE "refund_tickets"
  ADD COLUMN IF NOT EXISTS "source_inbound_email_id" uuid;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_refund_tickets_source_inbound"
  ON "refund_tickets" ("source_inbound_email_id");
--> statement-breakpoint

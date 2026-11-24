-- TrustShield Fase 2 — Notas persistentes de cliente.
--
-- Aditiva, idempotente. Cria customer_notes agrupada por email_normalized
-- (mesma normalização de @blackshop/shared/inbound/normalize-email.ts:
-- Gmail dot+plus insensitive; outros domínios literais).
--
-- Régua ética: notas ficam SEMPRE internas ao dono/operador. Nenhum
-- ponto do pipeline envia ao cliente. PII protegida em logs.

CREATE TABLE IF NOT EXISTS "customer_notes" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'default',
  "email_normalized" text NOT NULL,
  "note" text NOT NULL,
  "created_by" text NOT NULL DEFAULT 'operator',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_customer_notes_email"
  ON "customer_notes" ("store_id", "email_normalized", "created_at");
--> statement-breakpoint

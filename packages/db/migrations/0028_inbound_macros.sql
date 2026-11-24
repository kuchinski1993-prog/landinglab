-- TrustShield Fase 4 — Macros do operador.
--
-- Aditiva, idempotente. Textos pré-definidos que o operador aplica no
-- composer com 1 clique. NÃO enviados sozinhos — inseridos no composer
-- pra revisão + envio manual, passando pelo inbound-response-guard.

CREATE TABLE IF NOT EXISTS "inbound_macros" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'default',
  "title" text NOT NULL,
  "body" text NOT NULL,
  "category" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_macros_store"
  ON "inbound_macros" ("store_id", "sort_order");
--> statement-breakpoint

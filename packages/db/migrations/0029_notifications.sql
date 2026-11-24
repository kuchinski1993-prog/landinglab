-- TrustShield Fase D — Notificações internas do dono (sino).
--
-- Aditiva, idempotente. Notificações geradas pelo pipeline (chargeback,
-- suspicious_claim, refund pendente). Nunca vão ao cliente — são
-- exclusivamente internas para o dono decidir. Histórico preservado
-- (marca read_at, não deleta).

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'default',
  "type" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "link" text,
  "severity" text NOT NULL DEFAULT 'info',
  "read_at" timestamp with time zone,
  "related_email_id" uuid,
  "related_ticket_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Feed principal do sino: mais recentes primeiro, com filtro por lida.
CREATE INDEX IF NOT EXISTS "idx_notifications_feed"
  ON "notifications" ("store_id", "created_at" DESC);
--> statement-breakpoint

-- Idempotência de geração: um par (email, tipo) só gera uma vez.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_notifications_email_type"
  ON "notifications" ("store_id", "related_email_id", "type")
  WHERE "related_email_id" IS NOT NULL;
--> statement-breakpoint

-- Idempotência similar para tickets de refund.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_notifications_ticket_type"
  ON "notifications" ("store_id", "related_ticket_id", "type")
  WHERE "related_ticket_id" IS NOT NULL;
--> statement-breakpoint

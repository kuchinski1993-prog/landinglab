-- Migration 0091: marcações da Caixa de entrada do TrustShield (Story 16.1)
--
-- Lido / não lido, estrela e arquivado, no estilo Gmail. Tabela SEPARADA de
-- inbound_emails: só guarda o estado de organização do operador e não altera
-- status, categoria nem nenhuma decisão do pipeline do TrustShield.
--
-- Sem linha para um e-mail = não lido, sem estrela, não arquivado.
--
-- Backfill: e-mails que já existem e NÃO estão esperando resposta (respondidos,
-- spam, notificações de sistema, aguardando cliente) entram como lidos — assim
-- a caixa não amanhece com ~600 não lidos. Os que precisam de resposta
-- (received / classified / pending_human fora de spam) continuam não lidos.
--
-- Idempotente (IF NOT EXISTS + ON CONFLICT DO NOTHING).
-- Rollback: 0091_inbox_email_flags.rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "inbox_email_flags" (
  "inbound_email_id" uuid PRIMARY KEY REFERENCES "inbound_emails"("id") ON DELETE CASCADE,
  "store_id" text NOT NULL,
  "read_at" timestamptz,
  "starred" boolean NOT NULL DEFAULT false,
  "archived_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_inbox_email_flags_store_starred"
  ON "inbox_email_flags" ("store_id") WHERE "starred";
CREATE INDEX IF NOT EXISTS "idx_inbox_email_flags_store_archived"
  ON "inbox_email_flags" ("store_id") WHERE "archived_at" IS NOT NULL;

ALTER TABLE "inbox_email_flags" ENABLE ROW LEVEL SECURITY;

INSERT INTO "inbox_email_flags" ("inbound_email_id", "store_id", "read_at")
SELECT e."id", e."store_id", now()
FROM "inbound_emails" e
WHERE NOT (
  e."status" IN ('received', 'classified', 'pending_human')
  AND e."category" IS DISTINCT FROM 'spam_commercial'
)
ON CONFLICT ("inbound_email_id") DO NOTHING;

COMMIT;

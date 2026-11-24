-- Migration 0113: envio imediato pela Catalog API e histórico (Story 24.4, Epic 24)
--
-- Numeração: 0113 = próximo livre depois da 0112 (Story 24.3, mesma branch). A
-- story citava 0112, mas esse número ficou com a mídia. Renumerar no merge se
-- outra migration entrar antes.
--
-- meta_catalogs ganha a conexão com o catálogo da Meta:
--   meta_catalog_id       — id do catálogo no Commerce Manager;
--   meta_token_key        — CHAVE do token no Vault (meta_catalog.{id}.token).
--                           O token em si NUNCA fica nesta tabela (padrão CAPI);
--   meta_catalog_name     — nome devolvido pelo teste de conexão (badge);
--   connection_status     — connected | error (nulo = nunca testada);
--   push_enabled          — "Enviar mudanças na hora pela API" (padrão desligado);
--   pending_deletes       — retailer_ids removidos aguardando o DELETE na Meta;
--   last_synced_at        — último envio aceito pela Meta.
-- meta_catalog_items ganha sync_status (pending | synced | error; nulo = nunca
-- enviado), sync_error e synced_at.
-- Tabela NOVA meta_catalog_sync_events — histórico (feed_read, api_push,
-- connection_error). Sem IP, user-agent nem token: só contagens e mensagem.
-- Escopo: store_id text DEFAULT 'l0i' sem FK (padrão 0109/0111/0112).
--
-- RLS: a tabela nova nasce habilitada e SEM policies (deny-all para
-- anon/authenticated). O backend conecta como `postgres` (BYPASSRLS).
-- Depende da 0111. Idempotente (IF NOT EXISTS). NÃO APLICADA — exige aprovação
-- explícita do owner. Rollback: 0113_meta_catalog_sync.rollback.sql.

BEGIN;

DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0113 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

ALTER TABLE "meta_catalogs"
  ADD COLUMN IF NOT EXISTS "meta_catalog_id" text,
  ADD COLUMN IF NOT EXISTS "meta_token_key" text,
  ADD COLUMN IF NOT EXISTS "meta_catalog_name" text,
  ADD COLUMN IF NOT EXISTS "connection_status" text,
  ADD COLUMN IF NOT EXISTS "connection_error" text,
  ADD COLUMN IF NOT EXISTS "connection_checked_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "push_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pending_deletes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "last_synced_at" timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meta_catalogs_connection_status_check') THEN
    ALTER TABLE "meta_catalogs" ADD CONSTRAINT "meta_catalogs_connection_status_check"
      CHECK ("connection_status" IS NULL OR "connection_status" IN ('connected', 'error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meta_catalogs_meta_catalog_id_check') THEN
    ALTER TABLE "meta_catalogs" ADD CONSTRAINT "meta_catalogs_meta_catalog_id_check"
      CHECK ("meta_catalog_id" IS NULL OR "meta_catalog_id" ~ '^[0-9]{1,32}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meta_catalogs_pending_deletes_check') THEN
    ALTER TABLE "meta_catalogs" ADD CONSTRAINT "meta_catalogs_pending_deletes_check"
      CHECK (jsonb_typeof("pending_deletes") = 'array');
  END IF;
END $$;

ALTER TABLE "meta_catalog_items"
  ADD COLUMN IF NOT EXISTS "sync_status" text,
  ADD COLUMN IF NOT EXISTS "sync_error" text,
  ADD COLUMN IF NOT EXISTS "synced_at" timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meta_catalog_items_sync_status_check') THEN
    ALTER TABLE "meta_catalog_items" ADD CONSTRAINT "meta_catalog_items_sync_status_check"
      CHECK ("sync_status" IS NULL OR "sync_status" IN ('pending', 'synced', 'error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_meta_catalog_items_sync"
  ON "meta_catalog_items" ("catalog_id", "sync_status");

CREATE TABLE IF NOT EXISTS "meta_catalog_sync_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'l0i',
  "catalog_id" uuid NOT NULL REFERENCES "meta_catalogs"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "sent" integer,
  "accepted" integer,
  "rejected" integer,
  "message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "meta_catalog_sync_events_kind_check" CHECK ("kind" IN ('feed_read', 'api_push', 'connection_error')),
  CONSTRAINT "meta_catalog_sync_events_counts_check" CHECK (
    coalesce("sent", 0) >= 0 AND coalesce("accepted", 0) >= 0 AND coalesce("rejected", 0) >= 0
  )
);

CREATE INDEX IF NOT EXISTS "idx_meta_catalog_sync_events_catalog"
  ON "meta_catalog_sync_events" ("catalog_id", "created_at" DESC);

ALTER TABLE "meta_catalog_sync_events" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE meta_catalog_sync_events
  IS 'Story 24.4: histórico do catálogo Meta (leitura do feed, envio pela Catalog API, falha de conexão); sem IP, UA nem token';
COMMENT ON COLUMN meta_catalogs.meta_token_key
  IS 'Story 24.4: chave do token no Vault; o token nunca é gravado nesta tabela';

COMMIT;

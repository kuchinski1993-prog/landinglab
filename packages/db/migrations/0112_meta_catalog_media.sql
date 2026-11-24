-- Migration 0112: mídia dos catálogos Meta (Story 24.3, Epic 24)
--
-- Numeração: 0112 = próximo livre depois da 0111 (Story 24.1, mesma branch).
-- Renumerar no merge se outra migration entrar antes.
--
-- Tabela NOVA e isolada:
--   meta_catalog_media — um arquivo enviado ao bucket público `meta-catalog-media`
--                        (Supabase Storage). object_key versionado e único:
--                        catalogs/{catalog_id}/{item_id|shared}/{kind}-{uuid}_v{n}.{ext}
--                        (nunca sobrescreve). status: pending (URL de upload
--                        emitida) → active (conferido e em uso) → replaced (sem
--                        nenhum item apontando; replaced_at marca o início dos
--                        7 dias de guarda antes de o worker apagar).
-- FK só para meta_catalogs (0111), em cascata. item_id sem FK: o item pode ser
-- apagado e a mídia segue até a limpeza.
-- Escopo: store_id text DEFAULT 'l0i' sem FK (padrão 0109/0111).
--
-- RLS: nasce habilitado e SEM policies (deny-all para anon/authenticated),
-- padrão 0076/0092/0109/0111. O backend conecta como `postgres` (BYPASSRLS).
-- Depende da 0111. Idempotente (IF NOT EXISTS). NÃO APLICADA — exige aprovação
-- explícita do owner. Rollback: 0112_meta_catalog_media.rollback.sql.

BEGIN;

DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0112 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "meta_catalog_media" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'l0i',
  "catalog_id" uuid NOT NULL REFERENCES "meta_catalogs"("id") ON DELETE CASCADE,
  "item_id" uuid,
  "kind" text NOT NULL,
  "object_key" text NOT NULL,
  "public_url" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "width" integer,
  "height" integer,
  "version" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "replaced_at" timestamptz,
  "committed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "meta_catalog_media_kind_check" CHECK ("kind" IN ('image', 'video')),
  CONSTRAINT "meta_catalog_media_status_check" CHECK ("status" IN ('pending', 'active', 'replaced')),
  CONSTRAINT "meta_catalog_media_version_check" CHECK ("version" >= 1),
  CONSTRAINT "meta_catalog_media_size_check" CHECK ("size_bytes" > 0),
  CONSTRAINT "meta_catalog_media_url_check" CHECK ("public_url" LIKE 'https://%'),
  CONSTRAINT "meta_catalog_media_replaced_check" CHECK (("status" = 'replaced') = ("replaced_at" IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_meta_catalog_media_object_key"
  ON "meta_catalog_media" ("object_key");
CREATE INDEX IF NOT EXISTS "idx_meta_catalog_media_version"
  ON "meta_catalog_media" ("catalog_id", "item_id", "kind", "version");
CREATE INDEX IF NOT EXISTS "idx_meta_catalog_media_gc"
  ON "meta_catalog_media" ("status", "replaced_at");

ALTER TABLE "meta_catalog_media" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE meta_catalog_media
  IS 'Story 24.3: arquivos do bucket público meta-catalog-media; chave versionada _vN, replaced há 7 dias e sem referência → apagado pelo worker';

COMMIT;

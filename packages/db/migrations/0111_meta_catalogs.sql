-- Migration 0111: Catálogos Meta por produto (Story 24.1, Epic 24)
--
-- Numeração: 0111 = próximo livre conferindo origin/main e todas as branches
-- remotas em 2026-11-19 (origin/main vai até 0110). Renumerar no merge se
-- outra migration entrar antes.
--
-- Tabelas NOVAS e isoladas (sem FK para tabelas existentes):
--   meta_catalogs      — um catálogo por produto (landing, produto da loja ou
--                        manual), com feed_token aleatório (>= 32 bytes,
--                        base64url) usado na URL pública do feed programado.
--   meta_catalog_items — itens (kits) do catálogo. retailer_id estável e único
--                        por catálogo; images jsonb ordenado (a primeira é a
--                        principal) com CHECK de pelo menos 1 imagem — não
--                        existe item sem imagem real (regra 2 do epic).
-- Cascata: apagar o catálogo apaga os itens.
-- Escopo: store_id text DEFAULT 'l0i' sem FK (padrão 0109).
-- Telemetria: só last_read_at. Nada de IP ou user-agent de quem lê o feed.
--
-- RLS: nasce habilitado e SEM policies (deny-all para anon/authenticated),
-- padrão 0076/0092/0109. O backend conecta como `postgres` (BYPASSRLS).
-- Idempotente (IF NOT EXISTS). NÃO APLICADA — exige aprovação explícita do owner.
-- Rollback: 0111_meta_catalogs.rollback.sql (APAGA os catálogos e itens).

BEGIN;

DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0111 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "meta_catalogs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'l0i',
  "name" text NOT NULL,
  "source_kind" text NOT NULL,
  "source_ref" text,
  "currency" text NOT NULL,
  "locale" text NOT NULL,
  "brand" text,
  "default_destination_url" text,
  "feed_token" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "last_read_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "meta_catalogs_source_kind_check" CHECK ("source_kind" IN ('landing', 'store_product', 'manual')),
  CONSTRAINT "meta_catalogs_source_ref_check" CHECK (("source_kind" = 'manual') = ("source_ref" IS NULL)),
  CONSTRAINT "meta_catalogs_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "meta_catalogs_feed_token_check" CHECK (char_length("feed_token") >= 43)
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_meta_catalogs_feed_token"
  ON "meta_catalogs" ("feed_token");
CREATE INDEX IF NOT EXISTS "idx_meta_catalogs_store"
  ON "meta_catalogs" ("store_id", "created_at");

CREATE TABLE IF NOT EXISTS "meta_catalog_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "catalog_id" uuid NOT NULL REFERENCES "meta_catalogs"("id") ON DELETE CASCADE,
  "retailer_id" text NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "price_minor" integer NOT NULL,
  "sale_price_minor" integer,
  "images" jsonb NOT NULL,
  "videos" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "destination_url" text NOT NULL,
  "utm" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "availability" text NOT NULL DEFAULT 'in stock',
  "position" integer NOT NULL DEFAULT 0,
  "destination_status" integer,
  "destination_checked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "meta_catalog_items_images_check"
    CHECK (jsonb_typeof("images") = 'array' AND jsonb_array_length("images") >= 1),
  CONSTRAINT "meta_catalog_items_videos_check" CHECK (jsonb_typeof("videos") = 'array'),
  CONSTRAINT "meta_catalog_items_price_check" CHECK ("price_minor" >= 0),
  CONSTRAINT "meta_catalog_items_sale_price_check"
    CHECK ("sale_price_minor" IS NULL OR ("sale_price_minor" >= 0 AND "sale_price_minor" <= "price_minor")),
  CONSTRAINT "meta_catalog_items_availability_check"
    CHECK ("availability" IN ('in stock', 'out of stock', 'preorder', 'available for order')),
  CONSTRAINT "meta_catalog_items_destination_check" CHECK ("destination_url" LIKE 'https://%')
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_meta_catalog_items_retailer"
  ON "meta_catalog_items" ("catalog_id", "retailer_id");
CREATE INDEX IF NOT EXISTS "idx_meta_catalog_items_position"
  ON "meta_catalog_items" ("catalog_id", "position");

ALTER TABLE "meta_catalogs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meta_catalog_items" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE meta_catalogs
  IS 'Story 24.1: catálogo Meta por produto; feed público em /public/meta-catalogs/:feed_token.xml (corpo igual para qualquer leitor)';
COMMENT ON TABLE meta_catalog_items
  IS 'Story 24.1: itens (kits) do catálogo Meta; images[0] é a imagem principal, CHECK exige ao menos 1 imagem real';

COMMIT;

-- Migration 0035 — Collections & CollectionProducts.
--
-- Backfill de drift: as tabelas `collections` e `collection_products` foram
-- declaradas em packages/db/src/schema.ts desde a introdução do editor de
-- tema (rota GET /editor/collections em apps/api/src/routes/editor.routes.ts,
-- que alimenta o CollectionPicker das seções collection-products /
-- product-carousel), mas nunca ganharam uma migration correspondente.
--
-- Efeito prático em produção (Supabase): a rota /editor/collections retorna
-- 500 com `relation "collections" does not exist`. No dev local as tabelas
-- foram criadas fora do fluxo (provavelmente via psql manual), então o
-- drift passou despercebido — `pnpm --filter @blackshop/db exec tsx
-- src/migrate.ts` reporta sucesso porque não há migration a rodar.
--
-- Esta migration é IDempotente (`create table if not exists`, índices com
-- `if not exists`) para não quebrar o ambiente local, e é aditiva pura —
-- sem `drop`, sem `alter` em outras tabelas.

CREATE TABLE IF NOT EXISTS "collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'default',
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "image_url" text,
  -- 'manual' | 'best-selling' | 'newest' | 'price-asc' | 'price-desc' ...
  -- Convenção — checagem de valor fica no aplicativo, não em constraint.
  "sort_order" text NOT NULL DEFAULT 'manual',
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Unique por (store_id, slug): mesma loja não pode ter dois slugs iguais.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_collections_slug"
  ON "collections" ("store_id", "slug");

-- Filtro por loja em listagens do backoffice.
CREATE INDEX IF NOT EXISTS "idx_collections_store"
  ON "collections" ("store_id");

-- ─────────────────────────────────────────────────────────────────────────
-- Tabela de junção collections ↔ products (N:N) com ordem manual.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "collection_products" (
  "collection_id" uuid NOT NULL
    REFERENCES "collections"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL
    REFERENCES "products"("id") ON DELETE CASCADE,
  -- Ordem manual na coleção quando sort_order='manual'.
  "position" integer NOT NULL DEFAULT 0,
  "added_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("collection_id", "product_id")
);

-- Lookup reverso: "em quais coleções este produto está?"
CREATE INDEX IF NOT EXISTS "idx_cp_product"
  ON "collection_products" ("product_id");

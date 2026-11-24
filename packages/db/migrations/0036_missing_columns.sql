-- Migration 0036 — Colunas ausentes: products, product_variants, product_images, product_reviews.
--
-- Bug crítico em produção: GET /products devolvia 500 com
--   `column "subtitle" does not exist`
-- porque o schema.ts foi editado (adição das colunas de layout/preço/SEO)
-- sem gerar migration equivalente. O worker de import silenciosamente
-- também quebrava — o INSERT em products explodia ao referenciar `slug`,
-- que só existia no schema.
--
-- Drift completo detectado (schema.ts × banco pós-migrations aplicadas):
--   products:         subtitle, compare_at_price_brl, buy_button_text,
--                     sell_without_stock, slug, size_guide, show_size_table,
--                     rating, review_count
--   product_variants: stock, locked
--   product_images:   is_primary
--   product_reviews:  source
--
-- Tudo é aditivo (ADD COLUMN IF NOT EXISTS) — segura em prod (com dados)
-- e local (com/sem as colunas). Sem drops, sem defaults custosos.
-- Colunas NOT NULL recebem DEFAULT no ADD para não quebrar linhas
-- existentes (o postgres backfilla).

-- ── products ────────────────────────────────────────────────────────────
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "subtitle" text;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "compare_at_price_brl" numeric(10, 2);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "buy_button_text" text;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "sell_without_stock" boolean NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "slug" text;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "size_guide" text;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "show_size_table" boolean NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "rating" numeric(3, 2);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "review_count" integer NOT NULL DEFAULT 0;

-- ── product_variants ────────────────────────────────────────────────────
-- `stock` nullable (schema não força NOT NULL — variants podem existir sem
-- registro de estoque, o storefront trata null como "não gerenciado").
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "stock" integer;
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "locked" boolean NOT NULL DEFAULT false;

-- ── product_images ──────────────────────────────────────────────────────
-- is_primary é distinto de is_primary_for_color (que já existe): controla
-- a foto de capa do produto inteiro; is_primary_for_color controla a capa
-- por variação de cor.
ALTER TABLE "product_images" ADD COLUMN IF NOT EXISTS "is_primary" boolean NOT NULL DEFAULT false;

-- ── product_reviews ─────────────────────────────────────────────────────
-- source: 'manual' (backoffice) | 'imported' | 'trustshield' — para
-- separar review orgânica de importada em relatórios.
ALTER TABLE "product_reviews" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'manual';

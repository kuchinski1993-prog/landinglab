-- Migration 0039 — Templates de página (modelo Shopify).
--
-- Base: docs/research/2026-07-09-product-templates.md §3.1.
--
-- Uma transação (drizzle-orm/postgres-js roda migrations em transação por
-- padrão). DDL → INSERT do template padrão por tema → UPDATE de backfill
-- em theme_sections page='product' → sanity check com RAISE EXCEPTION.
--
-- Idempotente:
--   CREATE TABLE / INDEX / COLUMN → IF NOT EXISTS.
--   INSERT INTO theme_templates → WHERE NOT EXISTS.
--   UPDATE theme_sections → WHERE template_id IS NULL.
--
-- Se sobrar theme_sections page='product' com template_id NULL após o
-- backfill, aborta a transação. Melhor abortar do que criar PDP vazia
-- em produção.

-- ── 1. DDL: criar tabela + colunas ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS "theme_templates" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id"    text NOT NULL DEFAULT 'default',
  "theme_id"    uuid NOT NULL REFERENCES "themes"("id") ON DELETE CASCADE,
  -- Página que este template atende. Hoje 'product'; amanhã 'collection'.
  "page"        text NOT NULL,
  "name"        text NOT NULL,
  -- Padrão do tema para a página. Exatamente UM por (theme_id, page)
  -- via idx_theme_templates_default (partial unique).
  "is_default"  boolean NOT NULL DEFAULT false,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_theme_templates_page"
    CHECK ("page" IN ('product', 'collection'))
);

-- Nome único por tema + página, case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_theme_templates_name"
  ON "theme_templates" ("theme_id", "page", lower("name"));

-- Exatamente um padrão por (theme, page). Partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_theme_templates_default"
  ON "theme_templates" ("theme_id", "page")
  WHERE "is_default" = true;

-- Filtro rápido por tema/página no editor.
CREATE INDEX IF NOT EXISTS "idx_theme_templates_theme_page"
  ON "theme_templates" ("theme_id", "page");

-- FK ON DELETE CASCADE: excluir template apaga suas seções.
ALTER TABLE "theme_sections"
  ADD COLUMN IF NOT EXISTS "template_id" uuid
    REFERENCES "theme_templates"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_theme_sections_template"
  ON "theme_sections" ("template_id", "position");

-- FK ON DELETE SET NULL: excluir template devolve produtos ao padrão.
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "template_id" uuid
    REFERENCES "theme_templates"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_products_template"
  ON "products" ("template_id");

-- ── 2. Backfill: template padrão de PRODUTO por tema ────────────────────
-- Idempotente via WHERE NOT EXISTS.

INSERT INTO "theme_templates" ("store_id", "theme_id", "page", "name", "is_default")
SELECT t."store_id", t."id", 'product', 'Padrão', true
FROM "themes" t
WHERE NOT EXISTS (
  SELECT 1 FROM "theme_templates" tt
   WHERE tt."theme_id" = t."id"
     AND tt."page" = 'product'
     AND tt."is_default" = true
);

-- ── 3. Backfill: associar theme_sections page='product' ao padrão ───────
-- Idempotente: só atualiza NULL. Rerun não sobrescreve associações válidas.

UPDATE "theme_sections" AS ts
   SET "template_id" = tt."id"
  FROM "theme_templates" AS tt
 WHERE ts."page" = 'product'
   AND ts."template_id" IS NULL
   AND tt."theme_id" = ts."theme_id"
   AND tt."page" = 'product'
   AND tt."is_default" = true;

-- ── 4. Sanity check: aborta se sobrou órfão ─────────────────────────────

DO $$
DECLARE orphans int;
BEGIN
  SELECT count(*) INTO orphans
    FROM "theme_sections"
   WHERE "page" = 'product' AND "template_id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'Backfill incompleto: % theme_sections page=product sem template_id. Migration abortada.',
      orphans;
  END IF;
END $$;

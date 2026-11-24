-- Migration 0107: política de disponibilidade por produto e prazo de produção (Story 23.3)
--
-- Numeração PROVISÓRIA: depois da 0106 (23.2) na ordem da onda 17 (0106 → 0107 → 0108). O arquivo
-- não depende da 0106 nem de nenhuma migration posterior à 0001 (products/product_variants).
-- Se outra onda entrar antes, renumerar no merge.
--
-- Colunas (aditivas, sem backfill):
--   products.fulfillment_policy  text NOT NULL DEFAULT 'stock_only'
--       'stock_only'               — vende só o que há em estoque (comportamento de hoje)
--       'stock_then_made_to_order' — pronta entrega enquanto houver; depois, sob encomenda
--       'made_to_order_only'       — sempre sob encomenda (ignora estoque)
--   products.lead_time_days         integer NULL (1–365) — prazo de produção do produto
--   product_variants.lead_time_days integer NULL (1–365) — sobrescreve o do produto
--
-- A política só vale na leitura NATIVA de lojas ≠ 'default' (API pública/carrinho). O publish na
-- Shopify continua usando só products.sell_without_stock (inventoryPolicy) — nada muda para a Authen.
--
-- ADD COLUMN com DEFAULT constante = só metadado no Postgres ≥ 11 (sem reescrever a tabela).
-- Linhas existentes ficam 'stock_only'/NULL. Idempotente (IF NOT EXISTS + constraints checadas).
--
-- Ordem de deploy: ESTA MIGRATION ANTES DA API (o Drizzle lista as colunas no SELECT).
-- Rollback: 0107_fulfillment_policy.rollback.sql (descarta política e prazos).

BEGIN;

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "fulfillment_policy" text NOT NULL DEFAULT 'stock_only';
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "lead_time_days" integer;
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "lead_time_days" integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_fulfillment_policy_check') THEN
    ALTER TABLE "products" ADD CONSTRAINT "products_fulfillment_policy_check"
      CHECK ("fulfillment_policy" IN ('stock_only', 'stock_then_made_to_order', 'made_to_order_only'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_lead_time_days_check') THEN
    ALTER TABLE "products" ADD CONSTRAINT "products_lead_time_days_check"
      CHECK ("lead_time_days" IS NULL OR "lead_time_days" BETWEEN 1 AND 365);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_lead_time_days_check') THEN
    ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_lead_time_days_check"
      CHECK ("lead_time_days" IS NULL OR "lead_time_days" BETWEEN 1 AND 365);
  END IF;
END $$;

COMMIT;

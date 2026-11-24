-- Migration 0098: products.source_url único POR LOJA (Story 17.2b · Épico 17 multi-loja)
--
-- Antes: products.source_url era UNIQUE global, duas vezes (constraint
-- products_source_url_unique e índice idx_products_source_url, ambos da 0000).
-- Resultado: a segunda loja não conseguia importar um link que a primeira já
-- tinha importado. product_groups já é (store_id, source_url) desde a origem.
--
-- Expand → contract numa transação curta (products tem centenas de linhas):
--   1. cria o índice único (store_id, source_url) — MAIS permissivo que os
--      antigos: nenhuma linha existente o viola (não aborta por dado);
--   2. remove o índice global idx_products_source_url;
--   3. remove a constraint global products_source_url_unique.
-- Dentro da mesma loja o link continua deduplicado (o INSERT ... ON CONFLICT
-- DO NOTHING dos workers passa a valer pelo índice novo).
--
-- lock_timeout: se um import em lote estiver segurando a tabela, aborta em 5 s
-- (esquema intacto) em vez de enfileirar escritas atrás do CREATE INDEX.
--
-- Ordem de deploy: esta migration → API → worker. Rollback: 0098_…rollback.sql
-- (só recria o UNIQUE global se não houver source_url repetido entre lojas).

BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE UNIQUE INDEX IF NOT EXISTS "idx_products_store_source_url" ON "products" USING btree ("store_id", "source_url");
DROP INDEX IF EXISTS "idx_products_source_url";
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_source_url_unique";
COMMIT;

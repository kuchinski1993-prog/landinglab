-- Rollback da 0098 (Story 17.2b): volta products.source_url a UNIQUE global.
--
-- Só é possível se NENHUM source_url estiver repetido entre lojas. A checagem
-- roda DENTRO da mesma transação, antes de qualquer alteração: se houver
-- duplicata, o bloco DO aborta com a lista (até 20 URLs, com as lojas) e o
-- esquema fica intacto. Remova/renomeie as duplicatas entre lojas e rode de novo.
-- (Num cliente que mantém a sessão — psql interativo —, rode ROLLBACK depois do
-- erro para sair da transação abortada; nada foi aplicado.)
--
-- Ordem: checagem → recria products_source_url_unique e idx_products_source_url
-- → remove o índice por loja. Volte o código (API e worker) antes: o código da
-- 17.2b continua funcionando com o UNIQUE global, mas a segunda loja volta a não
-- conseguir importar links que outra loja já tem.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_total integer;
  v_lista text;
BEGIN
  SELECT count(*) INTO v_total
  FROM (SELECT source_url FROM products GROUP BY source_url HAVING count(*) > 1) d;

  IF v_total > 0 THEN
    SELECT string_agg(d.source_url || ' (lojas: ' || d.lojas || ')', E'\n' ORDER BY d.source_url) INTO v_lista
    FROM (
      SELECT source_url, string_agg(DISTINCT store_id, ', ' ORDER BY store_id) AS lojas
      FROM products
      GROUP BY source_url
      HAVING count(*) > 1
      ORDER BY source_url
      LIMIT 20
    ) d;

    RAISE EXCEPTION E'Rollback da 0098 abortado: % source_url repetido(s) entre lojas. Remova/renomeie as duplicatas entre lojas antes do rollback. Primeiros (até 20):\n%', v_total, v_lista;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_source_url_unique') THEN
    ALTER TABLE "products" ADD CONSTRAINT "products_source_url_unique" UNIQUE ("source_url");
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_products_source_url" ON "products" USING btree ("source_url");
DROP INDEX IF EXISTS "idx_products_store_source_url";
COMMIT;

-- Fase L · Cleanup dos grupos contaminados pelo bug do import-group.
--
-- Bug histórico (import-group.processor.ts pré-Fase L):
--   Ao importar N produtos de uma coleção Shopify, o processor criava
--   1 product_group com sourceUrl = URL da coleção e gravava esse
--   groupId em TODOS os N produtos. Consequência: a PDP de cada produto
--   mostrava os outros N-1 como "irmãos de variante" (color swatches
--   vindos de GET /api/storefront/products/group/:groupId).
--
-- Correção do fluxo (Fase L): import-group.processor.ts::saveOne agora
-- grava groupId=NULL. product_groups continua reservado exclusivamente
-- para SPLIT legítimo (import.processor.ts::saveProductGroup — 1 produto
-- com >99 variantes dividido em children).
--
-- Este script LIMPA os dados legados. Idempotente — pode rodar duas
-- vezes sem efeito colateral.
--
-- CRITÉRIO SEGURO para distinguir split de coleção:
--   Split legítimo: todos os products.source_url compartilham o mesmo
--     prefixo (child 0 = URL original; child N = URL?__child=N — ver
--     packages/importer/src/split.ts:85).
--   Coleção (bug):  URLs de origem completamente diferentes no mesmo
--     grupo (ANTIBES, CANNES, NICE, etc.).
--
-- Como rodar (leia antes de executar):
--   1) Dry-run — só lista o que vai mudar:
--      psql $DATABASE_URL -f fase-l-cleanup-collection-groups.sql
--   2) O script primeiro faz SELECT (mostrando grupos afetados), depois
--      o UPDATE. Confira o output do SELECT antes.
--
-- Recomendação para ambientes de produção: rodar dentro de uma
-- transação (BEGIN; ... COMMIT;) para conseguir ROLLBACK se algo parecer
-- errado — este arquivo NÃO abre transação implícita para deixar o dono
-- controlar.

-- Passo 1: identifica grupos "de coleção" (múltiplas origens distintas
-- depois de remover o sufixo ?__child=N). Se retornar vazio, nada a fazer.
SELECT
  group_id,
  COUNT(*) AS produtos_no_grupo,
  array_length(array_agg(DISTINCT split_part(source_url, '?__child=', 1)), 1) AS origens_distintas,
  array_agg(DISTINCT split_part(source_url, '?__child=', 1)) AS origens
FROM products
WHERE group_id IS NOT NULL AND status != 'archived'
GROUP BY group_id
HAVING array_length(array_agg(DISTINCT split_part(source_url, '?__child=', 1)), 1) > 1
ORDER BY produtos_no_grupo DESC;

-- Passo 2: zera group_id + group_position dos produtos afetados.
-- CTE isola só os grupos contaminados; UPDATE só toca esses.
WITH bug_groups AS (
  SELECT group_id
  FROM (
    SELECT
      group_id,
      array_agg(DISTINCT split_part(source_url, '?__child=', 1)) AS origins
    FROM products
    WHERE group_id IS NOT NULL AND status != 'archived'
    GROUP BY group_id
  ) g
  WHERE array_length(origins, 1) > 1
)
UPDATE products
SET group_id = NULL, group_position = NULL, updated_at = NOW()
WHERE group_id IN (SELECT group_id FROM bug_groups)
RETURNING id, title, source_url;

-- Passo 3: opcional — remove product_groups órfãos (sem nenhum produto
-- apontando pra ele). Também idempotente. Só faz sentido depois do UPDATE.
DELETE FROM product_groups
WHERE id NOT IN (
  SELECT DISTINCT group_id FROM products WHERE group_id IS NOT NULL
)
RETURNING id, source_url;

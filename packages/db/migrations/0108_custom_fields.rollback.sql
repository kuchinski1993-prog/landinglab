-- Rollback da 0108 (Story 23.4): remove os campos personalizados.
--
-- ATENÇÃO: APAGA todas as definições (de todas as lojas) e todos os valores preenchidos nos produtos.
-- Nenhuma outra tabela muda. A vitrine continua funcionando sem as tabelas (sem `custom_fields`).

BEGIN;
DROP TABLE IF EXISTS "product_custom_values";
DROP TABLE IF EXISTS "store_custom_fields";
COMMIT;

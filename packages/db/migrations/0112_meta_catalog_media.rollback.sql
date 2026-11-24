-- Rollback da migration 0112 (Story 24.3).
-- Apaga só o registro dos arquivos de mídia. Os objetos no bucket
-- `meta-catalog-media` NÃO são apagados (e as URLs nos itens seguem
-- funcionando); sem a tabela, a limpeza automática para.
-- Não toca em nenhuma outra tabela.

BEGIN;

DROP TABLE IF EXISTS "meta_catalog_media";

COMMIT;

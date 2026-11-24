-- Rollback da migration 0111 (Story 24.1).
-- Atenção: apaga TODOS os catálogos Meta e seus itens. Os links de feed
-- cadastrados no Commerce Manager passam a responder 404.
-- Não toca em nenhuma outra tabela.

BEGIN;

DROP TABLE IF EXISTS "meta_catalog_items";
DROP TABLE IF EXISTS "meta_catalogs";

COMMIT;

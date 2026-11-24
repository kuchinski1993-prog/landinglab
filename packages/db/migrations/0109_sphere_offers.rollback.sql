-- Rollback da migration 0109 (Story 16.1).
-- Atenção: apaga TODO o catálogo de ofertas Sphere (programas, funis e
-- materiais). Os dados podem ser recriados reimportando o JSON exportado.
-- Não toca em nenhuma tabela LandingLab/VSL.

BEGIN;

DROP TABLE IF EXISTS "sphere_offer_materials";
DROP TABLE IF EXISTS "sphere_offer_funnels";
DROP TABLE IF EXISTS "sphere_offer_programs";

COMMIT;

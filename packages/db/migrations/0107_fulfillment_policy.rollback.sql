-- Rollback da 0107 (Story 23.3): remove a política de disponibilidade e os prazos de produção.
--
-- Perde as políticas/prazos cadastrados (as lojas ≠ default voltam a "só estoque" na leitura).
-- A Authen não usa as colunas. ANTES do rollback, volte a API para a versão sem a 23.3 (o Drizzle
-- da versão nova lista estas colunas no SELECT).

BEGIN;
ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS "product_variants_lead_time_days_check";
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_lead_time_days_check";
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_fulfillment_policy_check";
ALTER TABLE "product_variants" DROP COLUMN IF EXISTS "lead_time_days";
ALTER TABLE "products" DROP COLUMN IF EXISTS "lead_time_days";
ALTER TABLE "products" DROP COLUMN IF EXISTS "fulfillment_policy";
COMMIT;

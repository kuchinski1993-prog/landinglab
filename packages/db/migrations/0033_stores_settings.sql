-- Migration 0033 — Store settings (business identity + policy variables).
--
-- Adiciona `settings jsonb` em `stores` para guardar dados de negócio que
-- alimentam os templates de políticas públicas da loja (nome do
-- responsável, endereço de contato, ICO, company/VAT numbers, data
-- "last updated"). É a fonte que a aba "Store Policies" do backoffice
-- edita e usa para gerar o HTML final que o dono cola na Shopify.
--
-- Shape esperado (validado no backend, chave por chave):
-- {
--   "responsibleName": "Will Kuchinski",
--   "contactAddress": "Hoxton Mix, 3rd Floor, ...",
--   "icoRegistration": "ZA123456",
--   "companyNumber": "12345678",
--   "vatNumber": "GB123456789",
--   "lastUpdated": "2026-07-08"
-- }
-- Todas as chaves são opcionais (rascunho progressivo — enquanto o dono
-- ainda não tem Ltd, company/VAT ficam vazios).
--
-- Aditiva. Default '{}' garante que rows existentes seguem válidos.

ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "settings" jsonb NOT NULL DEFAULT '{}'::jsonb;

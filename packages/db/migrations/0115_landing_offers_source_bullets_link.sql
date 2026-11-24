-- Migration 0115: modo das ofertas, bullets e link por oferta (Story 25.1, Epic 25)
--
-- landing_pages.offers_source escolhe, depois da clonagem, se a landing usa as
-- ofertas que vieram da página ('page', padrão) ou o bloco do sistema ('system').
-- landing_bundle_offers ganha bullets (lista editável) e checkout_url (link do
-- botão da oferta, com prioridade sobre o provider da seção Checkout).
-- Colunas novas com default: landings e ofertas existentes ficam intactas.
--
-- Depende da 0069. Idempotente (ADD COLUMN IF NOT EXISTS + DROP/ADD CONSTRAINT).
-- NÃO aplicada: aplicar só com aprovação do owner, ANTES do deploy do código da
-- 25.1. Rollback: 0115_landing_offers_source_bullets_link.rollback.sql.

BEGIN;

ALTER TABLE "landing_pages"
  ADD COLUMN IF NOT EXISTS "offers_source" text NOT NULL DEFAULT 'page';
ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_offers_source_check";
ALTER TABLE "landing_pages"
  ADD CONSTRAINT "landing_pages_offers_source_check" CHECK ("offers_source" IN ('page', 'system'));

ALTER TABLE "landing_bundle_offers"
  ADD COLUMN IF NOT EXISTS "bullets" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "landing_bundle_offers"
  ADD COLUMN IF NOT EXISTS "checkout_url" text;

COMMIT;

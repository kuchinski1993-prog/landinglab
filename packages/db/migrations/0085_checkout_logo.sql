-- Migration 0085: logo no header do checkout Stripe (Story 15.7)
--
-- landing_pages:
--   checkout_logo_url    — URL https pública do logo (Supabase Storage, gerada
--                          pelo upload do editor). NULL = header mostra o nome
--                          da marca (brand_to), como antes.
--   checkout_logo_height — altura do logo em px no desktop (16–120, padrão 32).
--                          A largura acompanha a proporção da imagem; no mobile
--                          o storefront limita a min(altura, 40px).
--   checkout_logo_align  — left | center | right (padrão left, como o Shopify).
--
-- Só apresentação: nada muda em sessões, pedidos ou valores.
-- NÃO aplicada automaticamente — o owner aplica antes do merge.
-- Rollback: 0085_checkout_logo.rollback.sql

BEGIN;

ALTER TABLE "landing_pages"
  ADD COLUMN IF NOT EXISTS "checkout_logo_url" text,
  ADD COLUMN IF NOT EXISTS "checkout_logo_height" integer NOT NULL DEFAULT 32,
  ADD COLUMN IF NOT EXISTS "checkout_logo_align" text NOT NULL DEFAULT 'left';

ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_checkout_logo_height_check";
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_checkout_logo_height_check"
  CHECK ("checkout_logo_height" BETWEEN 16 AND 120);
ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_checkout_logo_align_check";
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_checkout_logo_align_check"
  CHECK ("checkout_logo_align" IN ('left', 'center', 'right'));

COMMIT;

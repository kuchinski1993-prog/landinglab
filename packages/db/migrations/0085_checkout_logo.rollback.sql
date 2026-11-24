-- Rollback da migration 0085 (Story 15.7 — logo no header do checkout).
-- Atenção: apaga o logo/tamanho/alinhamento configurados; o header do
-- checkout volta a mostrar só o nome da marca. Os arquivos continuam no Storage.

BEGIN;

ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_checkout_logo_align_check";
ALTER TABLE "landing_pages" DROP CONSTRAINT IF EXISTS "landing_pages_checkout_logo_height_check";
ALTER TABLE "landing_pages"
  DROP COLUMN IF EXISTS "checkout_logo_align",
  DROP COLUMN IF EXISTS "checkout_logo_height",
  DROP COLUMN IF EXISTS "checkout_logo_url";

COMMIT;

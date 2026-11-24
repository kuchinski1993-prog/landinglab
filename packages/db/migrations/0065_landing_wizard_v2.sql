-- Migration 0065 — Wizard V2 (state persistence + OCR metadata)
--
-- Adiciona ao landing_pages:
--   1. wizard_step: máquina de estado do wizard V2 (retomar de onde parou)
--   2. wizard_state: JSONB com escolhas por etapa (idempotência)
--   3. image_ocr_metadata: cache OCR por imagem (etapa "Seleção de imagens")
--   4. display_currency: moeda dos preços dos bundles (ISO 4217)
--
-- Todas colunas nullable/defaults — não quebra rows existentes.

BEGIN;

ALTER TABLE "landing_pages"
    ADD COLUMN IF NOT EXISTS "wizard_step" text NOT NULL DEFAULT 'branding',
    ADD COLUMN IF NOT EXISTS "wizard_state" jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS "image_ocr_metadata" jsonb,
    ADD COLUMN IF NOT EXISTS "display_currency" text;

-- CHECK constraint ISO 4217 (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'landing_pages_display_currency_check'
  ) THEN
    ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_display_currency_check"
      CHECK (display_currency IS NULL OR display_currency IN (
        'BRL', 'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD',
        'MXN', 'ARS', 'COP', 'CLP', 'PEN', 'CHF', 'SEK', 'NOK'
      ));
  END IF;
END $$;

-- CHECK wizard_step (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'landing_pages_wizard_step_check'
  ) THEN
    ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_wizard_step_check"
      CHECK (wizard_step IN (
        'branding', 'images_selection', 'progress',
        'pricing', 'product', 'publish', 'done'
      ));
  END IF;
END $$;

-- Índice pra buscar landings paradas em uma etapa (analytics/retomar).
CREATE INDEX IF NOT EXISTS "idx_landing_pages_wizard_step"
  ON "landing_pages" ("store_id", "wizard_step")
  WHERE "wizard_step" != 'done';

COMMIT;

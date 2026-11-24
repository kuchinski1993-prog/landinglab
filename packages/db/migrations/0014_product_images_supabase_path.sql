-- Migration 0014: add supabase_path to product_images
-- Aditiva, nullable — sem breaking change, dentro de transação.
BEGIN;

ALTER TABLE "product_images"
  ADD COLUMN IF NOT EXISTS "supabase_path" text;

COMMIT;

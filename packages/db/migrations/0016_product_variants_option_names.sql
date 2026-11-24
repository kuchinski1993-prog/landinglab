BEGIN;

ALTER TABLE product_variants
  ADD COLUMN option1_name TEXT,
  ADD COLUMN option2_name TEXT,
  ADD COLUMN option3_name TEXT;

COMMIT;

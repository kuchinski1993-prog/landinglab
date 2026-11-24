BEGIN;

ALTER TABLE product_images
  ADD COLUMN color_value TEXT,
  ADD COLUMN is_primary_for_color BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_product_images_color_value
  ON product_images (product_id, color_value)
  WHERE color_value IS NOT NULL;

COMMIT;

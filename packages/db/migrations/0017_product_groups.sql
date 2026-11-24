BEGIN;

-- ── product_groups ────────────────────────────────────────────────────────────
-- Groups sibling products that were split from a single source (Feature B).
-- Each group maps to one source URL; children reference it via products.group_id.

CREATE TABLE product_groups (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   TEXT        NOT NULL DEFAULT 'default',
  source_url TEXT        NOT NULL,
  title      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_product_groups_source_url
  ON product_groups (store_id, source_url);

-- ── products — group columns ──────────────────────────────────────────────────
-- group_id NULL  → standalone product (unchanged behaviour for all existing rows)
-- group_id SET   → this product is a child of a group
-- group_position 0 → primary child (canonical storefront URL, lifestyle images)

ALTER TABLE products
  ADD COLUMN group_id       UUID    REFERENCES product_groups(id) ON DELETE SET NULL,
  ADD COLUMN group_position INTEGER;

CREATE INDEX idx_products_group
  ON products (group_id)
  WHERE group_id IS NOT NULL;

COMMIT;

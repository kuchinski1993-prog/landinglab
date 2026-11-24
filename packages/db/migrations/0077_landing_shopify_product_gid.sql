-- migration 0077: add shopify_product_gid to landing_pages
-- Persiste o GID Shopify do produto criado via publish-shopify.
-- Usado pra idempotência: se gid já existe, usa existingProductGid no adapter (retry mode).
-- Separado de landing_bundle_offers.variant_id — aqui é o produto, lá são as variantes.

ALTER TABLE "landing_pages"
  ADD COLUMN IF NOT EXISTS "shopify_product_gid" text;

COMMENT ON COLUMN landing_pages.shopify_product_gid
  IS 'GID Shopify do produto criado via /api/landing-pages/[id]/publish-shopify. Ex: gid://shopify/Product/12345. NULL quando produto não foi criado ainda.';

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "mirror_product_id" text;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "mirror_variant_id" text;

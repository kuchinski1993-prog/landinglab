-- Zero-downtime backfill: add nullable column, populate, then enforce NOT NULL.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "store_id" text DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE "publish_records" ADD COLUMN IF NOT EXISTS "store_id" text DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "store_id" text DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE "price_rules" ADD COLUMN IF NOT EXISTS "store_id" text DEFAULT 'default';
--> statement-breakpoint
UPDATE "products" SET "store_id" = 'default' WHERE "store_id" IS NULL;
--> statement-breakpoint
UPDATE "publish_records" SET "store_id" = 'default' WHERE "store_id" IS NULL;
--> statement-breakpoint
UPDATE "jobs" SET "store_id" = 'default' WHERE "store_id" IS NULL;
--> statement-breakpoint
UPDATE "price_rules" SET "store_id" = 'default' WHERE "store_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "store_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "publish_records" ALTER COLUMN "store_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "store_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "price_rules" ALTER COLUMN "store_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_products_store" ON "products" ("store_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_price_rules_store" ON "price_rules" ("store_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_store" ON "jobs" ("store_id");

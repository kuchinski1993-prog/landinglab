ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "name" text NOT NULL DEFAULT 'Default Store';
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "shopify_domain" text;
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
INSERT INTO "stores" ("id", "name", "domain", "shopify_domain", "is_active")
VALUES ('default', 'Default Store', NULL, NULL, true)
ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "is_active" = EXCLUDED."is_active";

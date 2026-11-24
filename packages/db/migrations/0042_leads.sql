CREATE TABLE IF NOT EXISTS "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"consent_marketing" boolean DEFAULT false NOT NULL,
	"coupon_shown" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_leads_store_email" ON "leads" USING btree ("store_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_leads_created" ON "leads" USING btree ("created_at");
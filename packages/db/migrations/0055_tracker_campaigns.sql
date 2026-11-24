-- Story Tracker.01 · tracker_campaigns
-- Uma campanha por produto anunciado no Meta Ads. slug é gerado server-side
-- (kebab(name)+'-'+nanoid(8)) e serve como identificador público em
-- /api/t/[slug]. meta_campaign_id/traffic_sources reservados pra sync
-- futuro com Meta Ads API (fora do escopo Story 01).

CREATE TABLE IF NOT EXISTS "tracker_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cost_model" text DEFAULT 'cpc' NOT NULL,
	"meta_campaign_id" text,
	"traffic_sources" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_tracker_campaigns_slug" ON "tracker_campaigns" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracker_campaigns_store_status" ON "tracker_campaigns" USING btree ("store_id","status");

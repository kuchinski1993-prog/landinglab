CREATE TABLE IF NOT EXISTS "tracking_pixels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL DEFAULT 'default',
	"pixel_id" text NOT NULL,
	"capi_token_key" text,
	"is_active" boolean NOT NULL DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracking_pixels_store" ON "tracking_pixels" ("store_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracking_pixels_active" ON "tracking_pixels" ("is_active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL DEFAULT 'default',
	"event_name" text NOT NULL,
	"event_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL DEFAULT 'sent',
	"payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracking_events_store" ON "tracking_events" ("store_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracking_events_event_name" ON "tracking_events" ("event_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracking_events_event_id" ON "tracking_events" ("event_id");

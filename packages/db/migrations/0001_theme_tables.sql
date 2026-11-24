CREATE TABLE IF NOT EXISTS "themes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "theme_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"theme_id" uuid NOT NULL,
	"type" text NOT NULL,
	"position" integer NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "theme_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"theme_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "theme_sections" ADD CONSTRAINT "theme_sections_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_themes_store" ON "themes" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_themes_active" ON "themes" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_theme_sections_theme" ON "theme_sections" USING btree ("theme_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_theme_sections_position" ON "theme_sections" USING btree ("theme_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_theme_versions_theme" ON "theme_versions" USING btree ("theme_id");

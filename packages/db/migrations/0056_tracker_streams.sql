-- Story Tracker.01 · tracker_streams
-- Fluxos de distribuição (cloaker). Cada campanha tem N streams avaliados
-- em ordem por order_index. Primeiro que satisfizer filter_logic sobre
-- filters[] ganha o clique. Stream sem filtros = fallback (catch-all).
-- filters[] é jsonb — schema validado em packages/tracker-engine/types.ts
-- (não em DB por flexibilidade).
--
-- ON DELETE CASCADE em campaign_id: deletar campanha remove streams.

CREATE TABLE IF NOT EXISTS "tracker_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"order_index" integer NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"is_white_page" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"filter_logic" text DEFAULT 'OR' NOT NULL,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action" text DEFAULT 'redirect' NOT NULL,
	"action_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_streams_campaign_id_fkey"
		FOREIGN KEY ("campaign_id") REFERENCES "tracker_campaigns"("id")
		ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracker_streams_campaign_order" ON "tracker_streams" USING btree ("campaign_id","order_index");

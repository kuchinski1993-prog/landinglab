-- Story Tracker.01 · tracker_clicks
-- Log de todos os cliques capturados pelo endpoint /api/t/[slug]. Insert
-- fire-and-forget do edge (não bloqueia latência do redirect). stream_id
-- null = bloqueado antes de match (bot óbvio). event_id (UUID) reservado
-- pra dedupe no Meta Conversions API (Story 6). ip é text (não inet) por
-- consistência com outros logs do Blackshop.
--
-- ON DELETE CASCADE em campaign_id: deletar campanha apaga histórico dela.
-- ON DELETE SET NULL em stream_id: deletar stream preserva histórico
-- (aparece como "sem fluxo" no dashboard).

CREATE TABLE IF NOT EXISTS "tracker_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"stream_id" uuid,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	-- Geo (IP lookup — MaxMind GeoLite2 na Story 3)
	"ip" text NOT NULL,
	"country_code" text,
	"region" text,
	"city" text,
	"isp" text,
	"proxy_detected" boolean DEFAULT false NOT NULL,
	-- Device (UA parsing — ua-parser-js na Story 3)
	"device_type" text,
	"os" text,
	"browser" text,
	"language" text,
	"user_agent" text,
	-- Source / attribution (parse da query string + headers)
	"referer" text,
	"fbclid" text,
	"sub1" text,
	"sub2" text,
	"sub3" text,
	"sub4" text,
	"sub5" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	-- Decisão do motor
	"redirect_url" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"block_reason" text,
	"is_converted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_clicks_campaign_id_fkey"
		FOREIGN KEY ("campaign_id") REFERENCES "tracker_campaigns"("id")
		ON DELETE CASCADE,
	CONSTRAINT "tracker_clicks_stream_id_fkey"
		FOREIGN KEY ("stream_id") REFERENCES "tracker_streams"("id")
		ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracker_clicks_campaign_created" ON "tracker_clicks" USING btree ("campaign_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracker_clicks_created_at" ON "tracker_clicks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracker_clicks_bot_blocked" ON "tracker_clicks" USING btree ("is_bot","is_blocked");

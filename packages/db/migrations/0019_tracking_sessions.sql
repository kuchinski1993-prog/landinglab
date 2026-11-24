-- Tracking Fase 2 — persiste as visitas de atribuição capturadas no navegador (Fase 1).
-- Honestidade: registra a ORIGEM do tráfego (fbclid, _fbp/_fbc, UTMs, landing/referrer)
-- para atribuição e match quality do Pixel/CAPI. Sem cloaking, sem white/black.
-- ip/user_agent/country ficam preparados para o ambiente do PC; no notebook ficam NULL.

-- gen_random_uuid() vem da extensão pgcrypto.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracking_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL DEFAULT 'default',
	"fbclid" text,
	"fbp" text,
	"fbc" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"landing_url" text,
	"referrer" text,
	"ip" text,
	"user_agent" text,
	"country" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracking_sessions_fbc" ON "tracking_sessions" ("fbc");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracking_sessions_fbclid" ON "tracking_sessions" ("fbclid");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracking_sessions_created" ON "tracking_sessions" ("created_at");

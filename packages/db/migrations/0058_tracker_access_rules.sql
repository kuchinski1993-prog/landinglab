-- Story Tracker.01 · tracker_access_rules
-- Blacklist/whitelist reutilizáveis. Cada regra tem 1 valor único — se
-- quer bloquear N IPs, cria N regras (padrão descoberto no recon do form
-- "Nova regra de acesso"). type=blacklist bloqueia matching, whitelist
-- permite apenas matching. target define qual campo do click comparar.

CREATE TABLE IF NOT EXISTS "tracker_access_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"target" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tracker_access_rules_store_type" ON "tracker_access_rules" USING btree ("store_id","type");

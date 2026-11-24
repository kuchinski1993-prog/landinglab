-- Story 12.1 · AI usage log
-- Rastreia gerações do endpoint /api/editor/ai/generate-image-prompts.
-- Usada para rate-limit (30/dia por user_id) e auditoria de custos.
-- MVP grava user_id='operator' (single-user backoffice). session_id
-- reservado para expansão pública/anônima (v2).

CREATE TABLE IF NOT EXISTS "ai_usage_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"session_id" text,
	"endpoint" text NOT NULL,
	"section_type" text,
	"prompt_count" integer DEFAULT 3 NOT NULL,
	"tokens_input" integer DEFAULT 0 NOT NULL,
	"tokens_output" integer DEFAULT 0 NOT NULL,
	"cost_estimate_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"mode" text DEFAULT 'mock' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_log_user_created" ON "ai_usage_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_log_session_created" ON "ai_usage_log" USING btree ("session_id","created_at");

CREATE TABLE IF NOT EXISTS "stores" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"domain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "themes" ADD COLUMN IF NOT EXISTS "tokens" jsonb NOT NULL DEFAULT '{}'::jsonb;

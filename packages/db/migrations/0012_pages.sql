BEGIN;

CREATE TABLE IF NOT EXISTS "pages" (
  "id"              uuid        NOT NULL DEFAULT gen_random_uuid(),
  "store_id"        text        NOT NULL DEFAULT 'default',
  "title"           text        NOT NULL,
  "slug"            text        NOT NULL,
  "content"         text        NOT NULL DEFAULT '',
  "status"          text        NOT NULL DEFAULT 'draft',
  "seo_title"       text,
  "seo_description" text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_pages_slug"   ON "pages" ("store_id", "slug");
CREATE        INDEX IF NOT EXISTS "idx_pages_store"  ON "pages" ("store_id");
CREATE        INDEX IF NOT EXISTS "idx_pages_status" ON "pages" ("status");

COMMIT;

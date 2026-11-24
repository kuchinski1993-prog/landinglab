-- VSL-10 — immutable source-bound translation extraction.
BEGIN;
CREATE TABLE IF NOT EXISTS vsl_translation_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES vsl_variants(id) ON DELETE RESTRICT,
  source_revision_id uuid NOT NULL REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  target_locale text NOT NULL,
  status text NOT NULL DEFAULT 'extracted' CHECK (status IN ('extracted','translating','review','stale','failed')),
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vsl_translation_batches_variant_idx ON vsl_translation_batches(variant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS vsl_translation_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL REFERENCES vsl_translation_batches(id) ON DELETE CASCADE,
  unit_key text NOT NULL, source_hash text NOT NULL, locator jsonb NOT NULL, extraction_type text NOT NULL,
  attribute text, original text NOT NULL, context text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','translated','reviewed','approved','rejected','stale')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(batch_id, unit_key)
);
COMMIT;

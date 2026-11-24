-- VSL-11 — review state, optimistic locking and audit trail.
BEGIN;
CREATE TABLE IF NOT EXISTS vsl_translation_reviews (
  unit_id uuid PRIMARY KEY REFERENCES vsl_translation_units(id) ON DELETE CASCADE,
  source_hash text NOT NULL, proposed text, edited text, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','translated','reviewed','approved','rejected')),
  locked_by text, version integer NOT NULL DEFAULT 1, audit jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;

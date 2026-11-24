-- Independent VSL pages and videos. Existing hosted landing data is untouched.
CREATE TABLE IF NOT EXISTS vsl_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL DEFAULT 'l0i',
  name text NOT NULL,
  current_revision_id uuid,
  legacy_page_id uuid UNIQUE REFERENCES landing_pages(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_pages_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS vsl_pages_store_idx ON vsl_pages (store_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS vsl_page_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES vsl_pages(id) ON DELETE RESTRICT,
  version_number integer NOT NULL,
  entry_path text NOT NULL,
  storage_prefix text NOT NULL UNIQUE,
  manifest jsonb NOT NULL,
  validation_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_sha256 text NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  legacy_revision_id uuid UNIQUE REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_page_revisions_page_number_unique UNIQUE (page_id, version_number),
  CONSTRAINT vsl_page_revisions_page_fingerprint_unique UNIQUE (page_id, fingerprint),
  CONSTRAINT vsl_page_revisions_page_id_unique UNIQUE (page_id, id),
  CONSTRAINT vsl_page_revisions_number_check CHECK (version_number > 0),
  CONSTRAINT vsl_page_revisions_source_check CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vsl_page_revisions_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vsl_page_revisions_status_check CHECK (status IN ('ready','failed','archived'))
);
CREATE INDEX IF NOT EXISTS vsl_page_revisions_page_idx ON vsl_page_revisions (page_id, version_number DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vsl_pages_current_revision_owner') THEN
    ALTER TABLE vsl_pages ADD CONSTRAINT vsl_pages_current_revision_owner
      FOREIGN KEY (id, current_revision_id) REFERENCES vsl_page_revisions(page_id, id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vsl_video_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL DEFAULT 'l0i',
  name text NOT NULL,
  provider text NOT NULL DEFAULT 'cloudflare_stream',
  provider_asset_id text,
  status text NOT NULL DEFAULT 'uploading',
  duration_seconds numeric(12,3),
  bytes bigint,
  mime_type text,
  playback_url text,
  poster_url text,
  error_message text,
  legacy_video_id uuid UNIQUE REFERENCES landing_video_assets(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_video_assets_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT vsl_video_assets_status_check CHECK (status IN ('uploading','processing','ready','failed','deleted')),
  CONSTRAINT vsl_video_assets_provider_check CHECK (provider = 'cloudflare_stream')
);
CREATE UNIQUE INDEX IF NOT EXISTS vsl_video_assets_provider_uid_idx
  ON vsl_video_assets (provider, provider_asset_id) WHERE provider_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vsl_video_assets_store_status_idx ON vsl_video_assets (store_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS vsl_video_upload_intents (
  id uuid PRIMARY KEY REFERENCES vsl_video_assets(id) ON DELETE RESTRICT,
  request_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  declared_bytes bigint NOT NULL,
  source_sha256 text NOT NULL,
  mime_type text NOT NULL,
  state text NOT NULL DEFAULT 'requested',
  provider_modified_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_video_upload_intents_bytes_check CHECK (declared_bytes BETWEEN 1 AND 5000000000),
  CONSTRAINT vsl_video_upload_intents_sha_check CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vsl_video_upload_intents_state_check CHECK (state IN ('requested','uploading','processing','ready','failed','deleted'))
);

CREATE TABLE IF NOT EXISTS vsl_asset_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_asset_id uuid REFERENCES vsl_video_assets(id) ON DELETE RESTRICT,
  page_revision_id uuid REFERENCES vsl_page_revisions(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES vsl_projects(id) ON DELETE RESTRICT,
  step_id uuid NOT NULL REFERENCES vsl_steps(id) ON DELETE RESTRICT,
  release_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_asset_references_one_asset_check CHECK ((video_asset_id IS NULL) <> (page_revision_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS vsl_asset_references_unique_idx
  ON vsl_asset_references (step_id, video_asset_id, page_revision_id, release_id) NULLS NOT DISTINCT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vsl_steps_page_revision_fk') THEN
    ALTER TABLE vsl_steps ADD CONSTRAINT vsl_steps_page_revision_fk
      FOREIGN KEY (page_revision_id) REFERENCES vsl_page_revisions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vsl_steps_video_asset_fk') THEN
    ALTER TABLE vsl_steps ADD CONSTRAINT vsl_steps_video_asset_fk
      FOREIGN KEY (video_asset_id) REFERENCES vsl_video_assets(id) ON DELETE RESTRICT;
  END IF;
END $$;

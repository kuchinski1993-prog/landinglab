-- VSL-01 — hosted pages, immutable revisions and domain ownership safety.
-- Forward-only and idempotent; existing LandingLab rows retain their legacy mode.

BEGIN;

CREATE TABLE IF NOT EXISTS landing_page_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL DEFAULT 'l0i',
  title text NOT NULL,
  source_locale text NOT NULL DEFAULT 'en',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_landing_page_families_store_title
  ON landing_page_families(store_id, title);

ALTER TABLE landing_pages
  ADD COLUMN IF NOT EXISTS content_mode text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS family_id uuid REFERENCES landing_page_families(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS locale text,
  ADD COLUMN IF NOT EXISTS published_version_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_landing_pages_hosted_family_locale
  ON landing_pages(family_id, locale)
  WHERE family_id IS NOT NULL AND locale IS NOT NULL;

CREATE TABLE IF NOT EXISTS landing_page_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landing_page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  source_version_id uuid,
  source_storage_key text,
  release_storage_prefix text,
  entry_path text NOT NULL DEFAULT 'index.html',
  html_body text NOT NULL,
  asset_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  checksum text,
  runtime_version text NOT NULL DEFAULT 'v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT landing_page_versions_number_check CHECK (version_number > 0),
  CONSTRAINT landing_page_versions_status_check CHECK (status IN ('draft','processing','ready','published','failed','archived')),
  UNIQUE(landing_page_id, version_number)
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'landing_page_versions_source_version_fk'
  ) THEN
    ALTER TABLE landing_page_versions
      ADD CONSTRAINT landing_page_versions_source_version_fk
      FOREIGN KEY (source_version_id) REFERENCES landing_page_versions(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_landing_page_versions_page_status
  ON landing_page_versions(landing_page_id, status);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_published_version_fk'
  ) THEN
    ALTER TABLE landing_pages
      ADD CONSTRAINT landing_pages_published_version_fk
      FOREIGN KEY (published_version_id) REFERENCES landing_page_versions(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION enforce_landing_published_version_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.published_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM landing_page_versions v
    WHERE v.id = NEW.published_version_id AND v.landing_page_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'published_version_id must reference a version of the same landing page';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS landing_pages_published_version_owner ON landing_pages;
CREATE TRIGGER landing_pages_published_version_owner
  BEFORE INSERT OR UPDATE OF published_version_id ON landing_pages
  FOR EACH ROW EXECUTE FUNCTION enforce_landing_published_version_owner();

CREATE TABLE IF NOT EXISTS landing_hosting_settings (
  landing_page_id uuid PRIMARY KEY REFERENCES landing_pages(id) ON DELETE CASCADE,
  video_asset_id uuid,
  video_selector text,
  checkout_url text,
  cta_selectors jsonb NOT NULL DEFAULT '[]'::jsonb,
  offer_selectors jsonb NOT NULL DEFAULT '[]'::jsonb,
  unlock_after_seconds integer NOT NULL DEFAULT 0 CHECK (unlock_after_seconds >= 0),
  tracking_params jsonb NOT NULL DEFAULT '{"allow":["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id","fbclid","gclid","ttclid","src","sck"]}'::jsonb,
  progress_policy text NOT NULL DEFAULT 'effective_playback',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS landing_video_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landing_page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'cloudflare_stream',
  provider_asset_id text,
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','processing','ready','failed','deleted')),
  duration_seconds integer,
  bytes integer,
  mime_type text,
  playback_url text,
  poster_url text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_landing_video_assets_provider_asset
  ON landing_video_assets(provider, provider_asset_id)
  WHERE provider_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_landing_video_assets_page_status
  ON landing_video_assets(landing_page_id, status);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'landing_hosting_settings_video_asset_fk'
  ) THEN
    ALTER TABLE landing_hosting_settings
      ADD CONSTRAINT landing_hosting_settings_video_asset_fk
      FOREIGN KEY (video_asset_id) REFERENCES landing_video_assets(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Existing domain rows are resources independent from pages. Removing a page
-- must clear the legacy pointer, never remove the purchased domain.
ALTER TABLE landing_domains
  ALTER COLUMN landing_page_id DROP NOT NULL;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'landing_domains'
    AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) ILIKE '%landing_page_id%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE landing_domains DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'landing_domains_landing_page_fk'
  ) THEN
    ALTER TABLE landing_domains
      ADD CONSTRAINT landing_domains_landing_page_fk
      FOREIGN KEY (landing_page_id) REFERENCES landing_pages(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;

-- VSL-09 — locale variants, immutable source links and shared assets.
-- VSL-only tables; no LandingLabs business tables are reused for behavior.
BEGIN;

CREATE TABLE IF NOT EXISTS vsl_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES landing_page_families(id) ON DELETE RESTRICT,
  page_id uuid NOT NULL UNIQUE REFERENCES landing_pages(id) ON DELETE RESTRICT,
  locale text NOT NULL CHECK (locale IN ('pt-BR','es','en','it','de','fr')),
  source_page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE RESTRICT,
  source_revision_id uuid NOT NULL REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(family_id, locale)
);
CREATE INDEX IF NOT EXISTS vsl_variants_source_revision_idx ON vsl_variants(source_revision_id);

CREATE TABLE IF NOT EXISTS vsl_variant_manifest_overrides (
  variant_id uuid PRIMARY KEY REFERENCES vsl_variants(id) ON DELETE CASCADE,
  base_revision_id uuid NOT NULL REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vsl_shared_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL UNIQUE,
  bytes bigint NOT NULL CHECK (bytes > 0),
  mime_type text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','pending_delete','deleted')),
  gc_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sha256, storage_key)
);

CREATE TABLE IF NOT EXISTS vsl_variant_asset_refs (
  variant_id uuid NOT NULL REFERENCES vsl_variants(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES vsl_shared_assets(id) ON DELETE RESTRICT,
  source_path text NOT NULL,
  manifest_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, source_path),
  UNIQUE (variant_id, manifest_path)
);
CREATE INDEX IF NOT EXISTS vsl_variant_asset_refs_asset_idx ON vsl_variant_asset_refs(asset_id);

CREATE TABLE IF NOT EXISTS vsl_asset_gc_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES vsl_shared_assets(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','deleted','cancelled')),
  not_before timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(asset_id, status)
);

CREATE OR REPLACE FUNCTION vsl_variant_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM landing_page_versions v WHERE v.id = NEW.source_revision_id AND v.landing_page_id = NEW.source_page_id) THEN
    RAISE EXCEPTION 'VSL variant source revision must belong to source page';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM landing_pages p WHERE p.id = NEW.page_id AND p.family_id = NEW.family_id AND p.locale = NEW.locale AND p.content_mode = 'hosted') THEN
    RAISE EXCEPTION 'VSL variant page must belong to family with matching locale';
  END IF;
  IF NEW.page_id = NEW.source_page_id THEN RAISE EXCEPTION 'VSL variant source and target page must differ'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS vsl_variant_source_guard ON vsl_variants;
CREATE TRIGGER vsl_variant_source_guard BEFORE INSERT OR UPDATE ON vsl_variants FOR EACH ROW EXECUTE FUNCTION vsl_variant_source_guard();

CREATE OR REPLACE FUNCTION vsl_asset_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM vsl_variant_asset_refs WHERE asset_id = OLD.id) THEN
    RAISE EXCEPTION 'VSL shared asset is still referenced';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS vsl_asset_reference_guard ON vsl_shared_assets;
CREATE TRIGGER vsl_asset_reference_guard BEFORE DELETE ON vsl_shared_assets FOR EACH ROW EXECUTE FUNCTION vsl_asset_reference_guard();

COMMIT;

-- Migration 0086: VSL Hosting — baseline consolidada (F0, 2026-10-07)
--
-- Substitui as migrations VSL originais (0074_vsl_hosted_foundation, 0076_vsl_*
-- .. 0087_vsl_*, 0082_blackshop_domain_registry_vsl_bindings e
-- 0088_vsl_prod_compat), movidas para migrations/_superseded_vsl/ (ver README).
--
-- Shape FINAL de todas as tabelas, colunas, funções, triggers, constraints e
-- índices VSL/foundation (39 tabelas). Totalmente idempotente:
--   - CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
--   - CREATE INDEX IF NOT EXISTS
--   - CREATE OR REPLACE FUNCTION
--   - constraints e triggers adicionados fora do CREATE TABLE são guardados por
--     checagem em pg_constraint / pg_trigger
-- Nenhum DROP. Nenhum ALTER em landing_domains (a FK landing_page_id continua
-- ON DELETE CASCADE, como em produção; o ALTER da antiga 0074 NÃO entra aqui).
--
-- Os CREATE TABLE preservam o texto das migrations originais (inclusive
-- constraints inline sem nome), para que os nomes automáticos gerados pelo
-- Postgres sejam idênticos aos de produção.
--
-- Produção (Supabase wedgklpuelrhqzauopze): estes objetos JÁ existem — o arquivo
-- é no-op lá e não precisa ser reaplicado. Aplicação em bancos dev/CI/staging:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 0086_vsl_baseline.sql
-- Sem BEGIN/COMMIT no arquivo: quem aplica controla a transação.
-- Fora do _journal.json (padrão do main desde 0076: SQL manual + .rollback.sql).
--
-- Requer PostgreSQL 15+ (NULLS NOT DISTINCT em vsl_asset_references).
-- Depende de: landing_pages, landing_domains (main).
-- RLS: 0087_vsl_rls.sql. Rollback (só dev): 0086_vsl_baseline.rollback.sql

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Foundation (conteúdo da antiga 0088_vsl_prod_compat; = 0074 sem landing_domains)
-- ═════════════════════════════════════════════════════════════════════════

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
CREATE INDEX IF NOT EXISTS idx_landing_page_versions_page_status
  ON landing_page_versions(landing_page_id, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'landing_page_versions'::regclass
      AND conname = 'landing_page_versions_source_version_fk'
  ) THEN
    ALTER TABLE landing_page_versions
      ADD CONSTRAINT landing_page_versions_source_version_fk
      FOREIGN KEY (source_version_id) REFERENCES landing_page_versions(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'landing_pages'::regclass
      AND conname = 'landing_pages_published_version_fk'
  ) THEN
    ALTER TABLE landing_pages
      ADD CONSTRAINT landing_pages_published_version_fk
      FOREIGN KEY (published_version_id) REFERENCES landing_page_versions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Corpo com a mesma indentação da 0088: prosrc idêntico ao de produção.
CREATE OR REPLACE FUNCTION enforce_landing_published_version_owner()
RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.published_version_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM landing_page_versions v
          WHERE v.id = NEW.published_version_id AND v.landing_page_id = NEW.id
        ) THEN
          RAISE EXCEPTION 'published_version_id must reference a version of the same landing page';
        END IF;
        RETURN NEW;
      END;
      $body$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'landing_pages'::regclass
      AND tgname = 'landing_pages_published_version_owner'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER landing_pages_published_version_owner
      BEFORE INSERT OR UPDATE OF published_version_id ON landing_pages
      FOR EACH ROW EXECUTE FUNCTION enforce_landing_published_version_owner();
  END IF;
END $$;

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
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'landing_hosting_settings'::regclass
      AND conname = 'landing_hosting_settings_video_asset_fk'
  ) THEN
    ALTER TABLE landing_hosting_settings
      ADD CONSTRAINT landing_hosting_settings_video_asset_fk
      FOREIGN KEY (video_asset_id) REFERENCES landing_video_assets(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Import lifecycle legacy G1 (antiga 0076_vsl_import_lifecycle)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vsl_imports (
 id uuid PRIMARY KEY, page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200), request_hash text NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'), source_key text NOT NULL, source_bytes bigint NOT NULL CHECK(source_bytes>0), extracted_bytes bigint NOT NULL DEFAULT 0 CHECK(extracted_bytes>=0), file_count integer NOT NULL DEFAULT 0 CHECK(file_count BETWEEN 0 AND 2000),
 kind text NOT NULL CHECK(kind IN ('html','zip')), config jsonb NOT NULL DEFAULT '{}', entry_path text,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','validating','extracting','analyzing','transforming','awaiting_selection','awaiting_resolution','materializing','verifying','sealing','committing','succeeded','failed','cancelled')),
 candidates jsonb NOT NULL DEFAULT '[]', report jsonb NOT NULL DEFAULT '{}', error text,
 fingerprint text, revision_id uuid REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
 active_attempt_id uuid, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(page_id,request_key), CONSTRAINT vsl_import_complete CHECK((status='succeeded')=(revision_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS vsl_import_attempts (
 id uuid PRIMARY KEY, import_id uuid NOT NULL REFERENCES vsl_imports(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('running','succeeded','failed','abandoned')), error text, release_id uuid, storage_prefix text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vsl_imports'::regclass
      AND conname = 'vsl_imports_active_attempt_id_vsl_import_attempts_id_fk'
  ) THEN
    ALTER TABLE vsl_imports
      ADD CONSTRAINT vsl_imports_active_attempt_id_vsl_import_attempts_id_fk
      FOREIGN KEY(active_attempt_id) REFERENCES vsl_import_attempts(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS vsl_releases (
 id uuid PRIMARY KEY, page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
 import_id uuid NOT NULL REFERENCES vsl_imports(id) ON DELETE RESTRICT, attempt_id uuid NOT NULL REFERENCES vsl_import_attempts(id) ON DELETE RESTRICT,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'), storage_prefix text NOT NULL UNIQUE,
 manifest jsonb NOT NULL, sealed_at timestamptz NOT NULL,
 revision_id uuid REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(page_id,fingerprint)
);
CREATE UNIQUE INDEX IF NOT EXISTS vsl_releases_revision ON vsl_releases(revision_id) WHERE revision_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS vsl_preview_sessions (
 id uuid PRIMARY KEY, grant_hash text NOT NULL UNIQUE CHECK(grant_hash ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','revoked')),
 origin_id text NOT NULL UNIQUE CHECK(origin_id ~ '^[0-9a-f]{32}$'), origin text NOT NULL UNIQUE,
 page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
 revision_id uuid NOT NULL REFERENCES landing_page_versions(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, hard_expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT vsl_preview_lease CHECK(expires_at<=hard_expires_at)
);
CREATE INDEX IF NOT EXISTS vsl_imports_status_lease ON vsl_imports(status,lease_until);
CREATE INDEX IF NOT EXISTS vsl_import_attempts_import ON vsl_import_attempts(import_id);
CREATE INDEX IF NOT EXISTS vsl_preview_sessions_expiry ON vsl_preview_sessions(expires_at);

CREATE OR REPLACE FUNCTION enforce_vsl_resource_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM landing_pages WHERE id=NEW.page_id AND content_mode='hosted' AND store_id='l0i') THEN RAISE EXCEPTION 'VSL hosted page required'; END IF;
 IF NEW.revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM landing_page_versions WHERE id=NEW.revision_id AND landing_page_id=NEW.page_id) THEN RAISE EXCEPTION 'VSL revision owner mismatch'; END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION enforce_vsl_release_import_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM vsl_imports WHERE id=NEW.import_id AND page_id=NEW.page_id) OR NOT EXISTS(SELECT 1 FROM vsl_import_attempts WHERE id=NEW.attempt_id AND import_id=NEW.import_id) THEN RAISE EXCEPTION 'VSL release import/attempt owner mismatch'; END IF;
 RETURN NEW;
END; $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'vsl_releases'::regclass AND tgname = 'vsl_release_import_owner' AND NOT tgisinternal) THEN
    CREATE TRIGGER vsl_release_import_owner BEFORE INSERT OR UPDATE ON vsl_releases FOR EACH ROW EXECUTE FUNCTION enforce_vsl_release_import_owner();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'vsl_imports'::regclass AND tgname = 'vsl_import_owner' AND NOT tgisinternal) THEN
    CREATE TRIGGER vsl_import_owner BEFORE INSERT OR UPDATE ON vsl_imports FOR EACH ROW EXECUTE FUNCTION enforce_vsl_resource_owner();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'vsl_releases'::regclass AND tgname = 'vsl_release_owner' AND NOT tgisinternal) THEN
    CREATE TRIGGER vsl_release_owner BEFORE INSERT OR UPDATE ON vsl_releases FOR EACH ROW EXECUTE FUNCTION enforce_vsl_resource_owner();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'vsl_preview_sessions'::regclass AND tgname = 'vsl_session_owner' AND NOT tgisinternal) THEN
    CREATE TRIGGER vsl_session_owner BEFORE INSERT OR UPDATE ON vsl_preview_sessions FOR EACH ROW EXECUTE FUNCTION enforce_vsl_resource_owner();
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Stream uploads legacy G1 (antiga 0077_vsl_stream_uploads)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vsl_video_uploads (
 id uuid PRIMARY KEY REFERENCES landing_video_assets(id) ON DELETE RESTRICT,
 page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE RESTRICT,
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200), request_hash text NOT NULL,
 declared_bytes bigint NOT NULL CHECK(declared_bytes BETWEEN 1 AND 5000000000),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'), mime_type text NOT NULL CHECK(mime_type IN ('video/mp4','video/quicktime','video/webm')),
 state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','provisioning','provisioning_uncertain','uploading','uploaded','processing','ready','failed','policy_rejected','delete_pending','deleted')),
 provider_id text UNIQUE CHECK(provider_id ~ '^[0-9a-f]{32}$'), provider_modified_at timestamptz,
 metadata jsonb NOT NULL DEFAULT '{}', error_code text, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(page_id,request_key)
);
CREATE INDEX IF NOT EXISTS vsl_video_uploads_state ON vsl_video_uploads(state,updated_at);
CREATE TABLE IF NOT EXISTS vsl_stream_events (
 body_hash text PRIMARY KEY CHECK(body_hash ~ '^[0-9a-f]{64}$'), video_id uuid NOT NULL REFERENCES vsl_video_uploads(id) ON DELETE RESTRICT,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vsl_video_references (
 id uuid PRIMARY KEY, video_id uuid NOT NULL REFERENCES vsl_video_uploads(id) ON DELETE RESTRICT,
 page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE RESTRICT,
 revision_id uuid REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('draft','revision')), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='revision')=(revision_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS vsl_video_reference_draft ON vsl_video_references(page_id) WHERE kind='draft';
CREATE UNIQUE INDEX IF NOT EXISTS vsl_video_reference_revision ON vsl_video_references(revision_id,video_id) WHERE kind='revision';

CREATE OR REPLACE FUNCTION vsl_video_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state_now text; owner uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.video_id::text,0));
 SELECT state,page_id INTO state_now,owner FROM vsl_video_uploads WHERE id=NEW.video_id;
 IF state_now IS NULL OR state_now IN ('delete_pending','deleted') OR owner<>NEW.page_id THEN RAISE EXCEPTION 'VSL video unavailable or owner mismatch'; END IF;
 IF NEW.revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM landing_page_versions WHERE id=NEW.revision_id AND landing_page_id=NEW.page_id) THEN RAISE EXCEPTION 'VSL video revision mismatch'; END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION vsl_video_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.video_asset_id IS NOT NULL AND EXISTS(SELECT 1 FROM vsl_video_uploads WHERE id=NEW.video_asset_id) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.video_asset_id::text,0));
  IF NOT EXISTS(SELECT 1 FROM vsl_video_uploads WHERE id=NEW.video_asset_id AND page_id=NEW.landing_page_id AND state NOT IN ('delete_pending','deleted')) THEN RAISE EXCEPTION 'VSL video draft unavailable'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION vsl_video_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE value jsonb; video uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM landing_pages WHERE id=NEW.landing_page_id AND content_mode='hosted' AND store_id='l0i') THEN RETURN NEW; END IF;
 FOR value IN SELECT jsonb_path_query(NEW.config_snapshot,'$.**.videoAssetId') UNION SELECT jsonb_path_query(NEW.config_snapshot,'$.**.video_asset_id') LOOP
  IF jsonb_typeof(value)='string' THEN
   video=trim(both '"' from value::text)::uuid;
   IF EXISTS(SELECT 1 FROM vsl_video_uploads WHERE id=video) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(video::text,0));
    IF NOT EXISTS(SELECT 1 FROM vsl_video_uploads WHERE id=video AND page_id=NEW.landing_page_id AND state NOT IN ('delete_pending','deleted')) THEN RAISE EXCEPTION 'VSL video revision unavailable'; END IF;
    INSERT INTO vsl_video_references(id,video_id,page_id,revision_id,kind) VALUES(gen_random_uuid(),video,NEW.landing_page_id,NEW.id,'revision') ON CONFLICT DO NOTHING;
   END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION vsl_video_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM landing_pages WHERE id=NEW.page_id AND content_mode='hosted' AND store_id='l0i') OR NOT EXISTS(SELECT 1 FROM landing_video_assets WHERE id=NEW.id AND landing_page_id=NEW.page_id AND provider='cloudflare_stream') THEN RAISE EXCEPTION 'VSL hosted video owner required'; END IF;
 RETURN NEW;
END; $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'vsl_video_references'::regclass AND tgname = 'vsl_video_reference_guard' AND NOT tgisinternal) THEN
    CREATE TRIGGER vsl_video_reference_guard BEFORE INSERT OR UPDATE ON vsl_video_references FOR EACH ROW EXECUTE FUNCTION vsl_video_lock_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'landing_hosting_settings'::regclass AND tgname = 'vsl_video_draft_guard' AND NOT tgisinternal) THEN
    CREATE TRIGGER vsl_video_draft_guard BEFORE INSERT OR UPDATE OF video_asset_id ON landing_hosting_settings FOR EACH ROW EXECUTE FUNCTION vsl_video_draft_guard();
  END IF;
  -- AFTER insert so the retained-reference FK can see the immutable VSL revision.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'landing_page_versions'::regclass AND tgname = 'vsl_video_revision_guard' AND NOT tgisinternal) THEN
    CREATE TRIGGER vsl_video_revision_guard AFTER INSERT ON landing_page_versions FOR EACH ROW EXECUTE FUNCTION vsl_video_revision_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'vsl_video_uploads'::regclass AND tgname = 'vsl_video_owner_guard' AND NOT tgisinternal) THEN
    CREATE TRIGGER vsl_video_owner_guard BEFORE INSERT OR UPDATE ON vsl_video_uploads FOR EACH ROW EXECUTE FUNCTION vsl_video_owner_guard();
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Domínio/publicação legacy G1 (antiga 0078_vsl_domain_publication)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vsl_domains (
  id uuid PRIMARY KEY,
  page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE RESTRICT,
  hostname text NOT NULL UNIQUE,
  dns_status text NOT NULL DEFAULT 'pending_dns',
  ssl_status text NOT NULL DEFAULT 'pending',
  publication_status text NOT NULL DEFAULT 'unpublished',
  expected_updated_at timestamptz,
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (hostname = lower(hostname) AND hostname !~ '[/:?#]'),
  CHECK (dns_status IN ('pending_dns','pending_verification','verified','error')),
  CHECK (ssl_status IN ('pending','provisioning','provisioned','error')),
  CHECK (publication_status IN ('unpublished','publishing','published','error'))
);
CREATE UNIQUE INDEX IF NOT EXISTS vsl_domains_page_active ON vsl_domains(page_id) WHERE publication_status='published';
CREATE TABLE IF NOT EXISTS vsl_publications (
  id uuid PRIMARY KEY,
  page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE RESTRICT,
  domain_id uuid NOT NULL REFERENCES vsl_domains(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
  cache_version bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'published',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(page_id, revision_id),
  CHECK (status IN ('published','unpublished'))
);
CREATE TABLE IF NOT EXISTS vsl_cache_invalidations (
  id uuid PRIMARY KEY,
  page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE RESTRICT,
  domain_id uuid REFERENCES vsl_domains(id) ON DELETE RESTRICT,
  cache_key text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ═════════════════════════════════════════════════════════════════════════
-- 5. Variantes e assets compartilhados legacy G2 (antiga 0079_vsl_variant_persistence)
-- ═════════════════════════════════════════════════════════════════════════

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

CREATE OR REPLACE FUNCTION vsl_asset_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM vsl_variant_asset_refs WHERE asset_id = OLD.id) THEN
    RAISE EXCEPTION 'VSL shared asset is still referenced';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'vsl_variants'::regclass AND tgname = 'vsl_variant_source_guard' AND NOT tgisinternal) THEN
    CREATE TRIGGER vsl_variant_source_guard BEFORE INSERT OR UPDATE ON vsl_variants FOR EACH ROW EXECUTE FUNCTION vsl_variant_source_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'vsl_shared_assets'::regclass AND tgname = 'vsl_asset_reference_guard' AND NOT tgisinternal) THEN
    CREATE TRIGGER vsl_asset_reference_guard BEFORE DELETE ON vsl_shared_assets FOR EACH ROW EXECUTE FUNCTION vsl_asset_reference_guard();
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 6. Tradução legacy G2 (antigas 0080_vsl_translation_extraction e 0081_vsl_translation_review)
-- ═════════════════════════════════════════════════════════════════════════

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
CREATE TABLE IF NOT EXISTS vsl_translation_reviews (
  unit_id uuid PRIMARY KEY REFERENCES vsl_translation_units(id) ON DELETE CASCADE,
  source_hash text NOT NULL, proposed text, edited text, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','translated','reviewed','approved','rejected')),
  locked_by text, version integer NOT NULL DEFAULT 1, audit jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ═════════════════════════════════════════════════════════════════════════
-- 7. Registro de domínios + bindings legacy G2 (antiga 0082_blackshop_domain_registry_vsl_bindings)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS blackshop_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname text NOT NULL,
  registrar text,
  registrar_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  dns_status text NOT NULL DEFAULT 'unknown',
  ssl_status text NOT NULL DEFAULT 'unknown',
  lifecycle_status text NOT NULL DEFAULT 'registered',
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blackshop_domains_hostname_unique UNIQUE (hostname),
  CONSTRAINT blackshop_domains_dns_status_check CHECK (dns_status IN ('unknown','pending','verified','failed')),
  CONSTRAINT blackshop_domains_ssl_status_check CHECK (ssl_status IN ('unknown','pending','provisioned','failed')),
  CONSTRAINT blackshop_domains_lifecycle_check CHECK (lifecycle_status IN ('registered','active','suspended','expired','archived'))
);
CREATE INDEX IF NOT EXISTS blackshop_domains_lifecycle_idx ON blackshop_domains (lifecycle_status, hostname);

CREATE TABLE IF NOT EXISTS vsl_domain_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL REFERENCES blackshop_domains(id) ON DELETE RESTRICT,
  page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE RESTRICT,
  revision_id uuid REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
  pathname text NOT NULL,
  normalized_pathname text NOT NULL,
  publication_status text NOT NULL DEFAULT 'draft',
  cache_version integer NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_domain_bindings_domain_path_unique UNIQUE (domain_id, normalized_pathname),
  CONSTRAINT vsl_domain_bindings_status_check CHECK (publication_status IN ('draft','pending','published','rolled_back','disabled'))
);
CREATE INDEX IF NOT EXISTS vsl_domain_bindings_host_path_idx ON vsl_domain_bindings (domain_id, normalized_pathname, publication_status);
CREATE INDEX IF NOT EXISTS vsl_domain_bindings_page_idx ON vsl_domain_bindings (page_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS vsl_domain_publication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES vsl_domain_bindings(id) ON DELETE CASCADE,
  from_revision_id uuid REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
  to_revision_id uuid REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vsl_domain_publication_events_binding_idx ON vsl_domain_publication_events (binding_id, created_at DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- 8. Funis G3: projetos e etapas (antiga 0083_vsl_projects_steps)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vsl_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL DEFAULT 'l0i',
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  default_checkout_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_tracking_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  active_release_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_projects_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT vsl_projects_status_check CHECK (status IN ('draft','published','archived')),
  CONSTRAINT vsl_projects_version_check CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS vsl_projects_store_updated_idx ON vsl_projects (store_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS vsl_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES vsl_projects(id) ON DELETE RESTRICT,
  position integer NOT NULL,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'PAGE',
  pathname text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  render_mode text NOT NULL DEFAULT 'IMPORTED_PAGE',
  page_revision_id uuid,
  video_asset_id uuid,
  checkout_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  cta_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  tracking_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_step_id uuid,
  publication_state text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_steps_project_id_unique UNIQUE (project_id, id),
  CONSTRAINT vsl_steps_project_position_unique UNIQUE (project_id, position),
  CONSTRAINT vsl_steps_project_path_unique UNIQUE (project_id, pathname),
  CONSTRAINT vsl_steps_position_check CHECK (position >= 0),
  CONSTRAINT vsl_steps_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT vsl_steps_type_check CHECK (type IN ('PAGE','QUIZ','PRESELL','VSL','CHECKOUT','CUSTOM')),
  CONSTRAINT vsl_steps_status_check CHECK (status IN ('draft','ready','archived')),
  CONSTRAINT vsl_steps_render_mode_check CHECK (render_mode IN ('IMPORTED_PAGE','NATIVE_VIDEO','REDIRECT')),
  CONSTRAINT vsl_steps_publication_state_check CHECK (publication_state IN ('draft','published','unpublished')),
  CONSTRAINT vsl_steps_path_check CHECK (pathname LIKE '/%' AND (pathname = '/' OR pathname NOT LIKE '%/')),
  CONSTRAINT vsl_steps_next_not_self CHECK (next_step_id IS NULL OR next_step_id <> id),
  CONSTRAINT vsl_steps_version_check CHECK (version > 0),
  CONSTRAINT vsl_steps_next_same_project FOREIGN KEY (project_id, next_step_id)
    REFERENCES vsl_steps(project_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS vsl_steps_project_status_idx ON vsl_steps (project_id, status, position);

-- ═════════════════════════════════════════════════════════════════════════
-- 9. Páginas e vídeos independentes G3 (antiga 0084_vsl_independent_assets)
-- ═════════════════════════════════════════════════════════════════════════

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
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vsl_pages'::regclass AND conname = 'vsl_pages_current_revision_owner'
  ) THEN
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vsl_steps'::regclass AND conname = 'vsl_steps_page_revision_fk'
  ) THEN
    ALTER TABLE vsl_steps ADD CONSTRAINT vsl_steps_page_revision_fk
      FOREIGN KEY (page_revision_id) REFERENCES vsl_page_revisions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vsl_steps'::regclass AND conname = 'vsl_steps_video_asset_fk'
  ) THEN
    ALTER TABLE vsl_steps ADD CONSTRAINT vsl_steps_video_asset_fk
      FOREIGN KEY (video_asset_id) REFERENCES vsl_video_assets(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 10. Publicação de funis G3 (antiga 0085_vsl_funnel_publication)
-- ═════════════════════════════════════════════════════════════════════════

-- ADD COLUMN (e não no CREATE TABLE) para manter a ordem de colunas de produção.
ALTER TABLE vsl_projects ADD COLUMN IF NOT EXISTS domain_id uuid REFERENCES blackshop_domains(id) ON DELETE RESTRICT;
ALTER TABLE vsl_steps ADD COLUMN IF NOT EXISTS video_placement jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS vsl_project_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES vsl_projects(id) ON DELETE RESTRICT,
  version_number integer NOT NULL,
  domain_id uuid NOT NULL REFERENCES blackshop_domains(id) ON DELETE RESTRICT,
  previous_release_id uuid,
  config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_project_releases_project_version_unique UNIQUE (project_id, version_number),
  CONSTRAINT vsl_project_releases_project_id_unique UNIQUE (project_id, id),
  CONSTRAINT vsl_project_releases_version_check CHECK (version_number > 0)
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vsl_project_releases'::regclass AND conname = 'vsl_project_releases_previous_fk'
  ) THEN
    ALTER TABLE vsl_project_releases ADD CONSTRAINT vsl_project_releases_previous_fk
      FOREIGN KEY (previous_release_id) REFERENCES vsl_project_releases(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vsl_projects'::regclass AND conname = 'vsl_projects_active_release_fk'
  ) THEN
    ALTER TABLE vsl_projects ADD CONSTRAINT vsl_projects_active_release_fk
      FOREIGN KEY (id, active_release_id) REFERENCES vsl_project_releases(project_id, id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vsl_step_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_release_id uuid NOT NULL REFERENCES vsl_project_releases(id) ON DELETE RESTRICT,
  step_id uuid NOT NULL REFERENCES vsl_steps(id) ON DELETE RESTRICT,
  position integer NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  pathname text NOT NULL,
  render_mode text NOT NULL,
  page_revision_id uuid REFERENCES vsl_page_revisions(id) ON DELETE RESTRICT,
  video_asset_id uuid REFERENCES vsl_video_assets(id) ON DELETE RESTRICT,
  video_placement jsonb NOT NULL DEFAULT '{}'::jsonb,
  checkout_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  cta_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  tracking_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_step_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_step_releases_step_unique UNIQUE (project_release_id, step_id),
  CONSTRAINT vsl_step_releases_path_unique UNIQUE (project_release_id, pathname),
  CONSTRAINT vsl_step_releases_position_unique UNIQUE (project_release_id, position)
);
CREATE INDEX IF NOT EXISTS vsl_step_releases_step_idx ON vsl_step_releases (step_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vsl_public_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL REFERENCES blackshop_domains(id) ON DELETE RESTRICT,
  pathname text NOT NULL,
  project_id uuid NOT NULL REFERENCES vsl_projects(id) ON DELETE RESTRICT,
  step_id uuid NOT NULL REFERENCES vsl_steps(id) ON DELETE RESTRICT,
  active_project_release_id uuid REFERENCES vsl_project_releases(id) ON DELETE RESTRICT,
  active_step_release_id uuid REFERENCES vsl_step_releases(id) ON DELETE RESTRICT,
  publication_status text NOT NULL DEFAULT 'published',
  cache_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_public_routes_domain_path_unique UNIQUE (domain_id, pathname),
  CONSTRAINT vsl_public_routes_status_check CHECK (publication_status IN ('published','unpublished')),
  CONSTRAINT vsl_public_routes_active_pair_check CHECK ((active_project_release_id IS NULL) = (active_step_release_id IS NULL))
);
CREATE INDEX IF NOT EXISTS vsl_public_routes_project_idx ON vsl_public_routes (project_id, publication_status);

CREATE TABLE IF NOT EXISTS vsl_publication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES vsl_projects(id) ON DELETE RESTRICT,
  from_release_id uuid REFERENCES vsl_project_releases(id) ON DELETE RESTRICT,
  to_release_id uuid REFERENCES vsl_project_releases(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_publication_events_type_check CHECK (event_type IN ('publish','rollback','unpublish'))
);
CREATE INDEX IF NOT EXISTS vsl_publication_events_project_idx ON vsl_publication_events (project_id, created_at DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- 11. Analytics G3 (antiga 0086_vsl_analytics). Sem PII de visitante.
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vsl_events (
  event_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vsl_projects(id) ON DELETE RESTRICT,
  step_id uuid NOT NULL REFERENCES vsl_steps(id) ON DELETE RESTRICT,
  release_id uuid NOT NULL REFERENCES vsl_project_releases(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  event_name text NOT NULL,
  cta_id text NOT NULL DEFAULT '',
  watched_seconds numeric(12,3),
  watched_percentage numeric(6,5),
  event_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_events_name_check CHECK (event_name IN ('PageView','VSLStart','VSL25','VSL50','VSL75','VSLComplete','CTAVisible','CTAClick','CheckoutClick','WatchProgress')),
  CONSTRAINT vsl_events_watched_check CHECK (watched_seconds IS NULL OR watched_seconds BETWEEN 0 AND 7200),
  CONSTRAINT vsl_events_percentage_check CHECK (watched_percentage IS NULL OR watched_percentage BETWEEN 0 AND 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS vsl_events_session_action_unique
  ON vsl_events (release_id, step_id, session_id, event_name, cta_id) WHERE event_name <> 'WatchProgress';
CREATE INDEX IF NOT EXISTS vsl_events_project_step_time_idx ON vsl_events (project_id, step_id, received_at DESC);

CREATE TABLE IF NOT EXISTS vsl_watch_sessions (
  release_id uuid NOT NULL REFERENCES vsl_project_releases(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES vsl_projects(id) ON DELETE RESTRICT,
  step_id uuid NOT NULL REFERENCES vsl_steps(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  watched_seconds numeric(12,3) NOT NULL DEFAULT 0,
  watched_percentage numeric(6,5) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (release_id, step_id, session_id),
  CONSTRAINT vsl_watch_sessions_seconds_check CHECK (watched_seconds BETWEEN 0 AND 7200),
  CONSTRAINT vsl_watch_sessions_percentage_check CHECK (watched_percentage BETWEEN 0 AND 1)
);
CREATE INDEX IF NOT EXISTS vsl_watch_sessions_project_step_idx ON vsl_watch_sessions (project_id, step_id);

-- ═════════════════════════════════════════════════════════════════════════
-- 12. Ponte legacy → G3 (antiga 0087_vsl_legacy_bridge)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vsl_legacy_project_links (
  legacy_page_id uuid PRIMARY KEY REFERENCES landing_pages(id) ON DELETE RESTRICT,
  legacy_revision_id uuid NOT NULL REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
  legacy_video_id uuid REFERENCES landing_video_assets(id) ON DELETE RESTRICT,
  legacy_binding_id uuid REFERENCES vsl_domain_bindings(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL UNIQUE REFERENCES vsl_projects(id) ON DELETE RESTRICT,
  step_id uuid NOT NULL UNIQUE REFERENCES vsl_steps(id) ON DELETE RESTRICT,
  migration_state text NOT NULL DEFAULT 'draft_mapped',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_legacy_project_links_state_check CHECK (migration_state IN ('draft_mapped','reconciled','cutover'))
);

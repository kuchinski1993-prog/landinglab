-- VSL-03 only. Additive; no historical migration edits.
BEGIN;
CREATE TABLE vsl_imports (
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
CREATE TABLE vsl_import_attempts (
 id uuid PRIMARY KEY, import_id uuid NOT NULL REFERENCES vsl_imports(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('running','succeeded','failed','abandoned')), error text, release_id uuid, storage_prefix text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
ALTER TABLE vsl_imports ADD CONSTRAINT vsl_imports_active_attempt_id_vsl_import_attempts_id_fk FOREIGN KEY(active_attempt_id) REFERENCES vsl_import_attempts(id) ON DELETE SET NULL;
CREATE TABLE vsl_releases (
 id uuid PRIMARY KEY, page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
 import_id uuid NOT NULL REFERENCES vsl_imports(id) ON DELETE RESTRICT, attempt_id uuid NOT NULL REFERENCES vsl_import_attempts(id) ON DELETE RESTRICT,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'), storage_prefix text NOT NULL UNIQUE,
 manifest jsonb NOT NULL, sealed_at timestamptz NOT NULL,
 revision_id uuid REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(page_id,fingerprint)
);
CREATE UNIQUE INDEX vsl_releases_revision ON vsl_releases(revision_id) WHERE revision_id IS NOT NULL;
CREATE TABLE vsl_preview_sessions (
 id uuid PRIMARY KEY, grant_hash text NOT NULL UNIQUE CHECK(grant_hash ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','revoked')),
 origin_id text NOT NULL UNIQUE CHECK(origin_id ~ '^[0-9a-f]{32}$'), origin text NOT NULL UNIQUE,
 page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
 revision_id uuid NOT NULL REFERENCES landing_page_versions(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, hard_expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT vsl_preview_lease CHECK(expires_at<=hard_expires_at)
);
CREATE INDEX vsl_imports_status_lease ON vsl_imports(status,lease_until);
CREATE INDEX vsl_import_attempts_import ON vsl_import_attempts(import_id);
CREATE INDEX vsl_preview_sessions_expiry ON vsl_preview_sessions(expires_at);
CREATE FUNCTION enforce_vsl_resource_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM landing_pages WHERE id=NEW.page_id AND content_mode='hosted' AND store_id='l0i') THEN RAISE EXCEPTION 'VSL hosted page required'; END IF;
 IF NEW.revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM landing_page_versions WHERE id=NEW.revision_id AND landing_page_id=NEW.page_id) THEN RAISE EXCEPTION 'VSL revision owner mismatch'; END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION enforce_vsl_release_import_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM vsl_imports WHERE id=NEW.import_id AND page_id=NEW.page_id) OR NOT EXISTS(SELECT 1 FROM vsl_import_attempts WHERE id=NEW.attempt_id AND import_id=NEW.import_id) THEN RAISE EXCEPTION 'VSL release import/attempt owner mismatch'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER vsl_release_import_owner BEFORE INSERT OR UPDATE ON vsl_releases FOR EACH ROW EXECUTE FUNCTION enforce_vsl_release_import_owner();
CREATE TRIGGER vsl_import_owner BEFORE INSERT OR UPDATE ON vsl_imports FOR EACH ROW EXECUTE FUNCTION enforce_vsl_resource_owner();
CREATE TRIGGER vsl_release_owner BEFORE INSERT OR UPDATE ON vsl_releases FOR EACH ROW EXECUTE FUNCTION enforce_vsl_resource_owner();
CREATE TRIGGER vsl_session_owner BEFORE INSERT OR UPDATE ON vsl_preview_sessions FOR EACH ROW EXECUTE FUNCTION enforce_vsl_resource_owner();
COMMIT;

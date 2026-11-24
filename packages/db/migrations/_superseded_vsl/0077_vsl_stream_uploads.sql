-- VSL-04 operational state; does not modify historical SQL or legacy business flows.
BEGIN;
CREATE TABLE vsl_video_uploads (
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
CREATE INDEX vsl_video_uploads_state ON vsl_video_uploads(state,updated_at);
CREATE TABLE vsl_stream_events (
 body_hash text PRIMARY KEY CHECK(body_hash ~ '^[0-9a-f]{64}$'), video_id uuid NOT NULL REFERENCES vsl_video_uploads(id) ON DELETE RESTRICT,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE vsl_video_references (
 id uuid PRIMARY KEY, video_id uuid NOT NULL REFERENCES vsl_video_uploads(id) ON DELETE RESTRICT,
 page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE RESTRICT,
 revision_id uuid REFERENCES landing_page_versions(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('draft','revision')), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='revision')=(revision_id IS NOT NULL))
);
CREATE UNIQUE INDEX vsl_video_reference_draft ON vsl_video_references(page_id) WHERE kind='draft';
CREATE UNIQUE INDEX vsl_video_reference_revision ON vsl_video_references(revision_id,video_id) WHERE kind='revision';
CREATE FUNCTION vsl_video_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state_now text; owner uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.video_id::text,0));
 SELECT state,page_id INTO state_now,owner FROM vsl_video_uploads WHERE id=NEW.video_id;
 IF state_now IS NULL OR state_now IN ('delete_pending','deleted') OR owner<>NEW.page_id THEN RAISE EXCEPTION 'VSL video unavailable or owner mismatch'; END IF;
 IF NEW.revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM landing_page_versions WHERE id=NEW.revision_id AND landing_page_id=NEW.page_id) THEN RAISE EXCEPTION 'VSL video revision mismatch'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER vsl_video_reference_guard BEFORE INSERT OR UPDATE ON vsl_video_references FOR EACH ROW EXECUTE FUNCTION vsl_video_lock_guard();
CREATE FUNCTION vsl_video_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.video_asset_id IS NOT NULL AND EXISTS(SELECT 1 FROM vsl_video_uploads WHERE id=NEW.video_asset_id) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.video_asset_id::text,0));
  IF NOT EXISTS(SELECT 1 FROM vsl_video_uploads WHERE id=NEW.video_asset_id AND page_id=NEW.landing_page_id AND state NOT IN ('delete_pending','deleted')) THEN RAISE EXCEPTION 'VSL video draft unavailable'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER vsl_video_draft_guard BEFORE INSERT OR UPDATE OF video_asset_id ON landing_hosting_settings FOR EACH ROW EXECUTE FUNCTION vsl_video_draft_guard();
CREATE FUNCTION vsl_video_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
-- AFTER insert so the retained-reference FK can see the immutable VSL revision.
CREATE TRIGGER vsl_video_revision_guard AFTER INSERT ON landing_page_versions FOR EACH ROW EXECUTE FUNCTION vsl_video_revision_guard();
CREATE FUNCTION vsl_video_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM landing_pages WHERE id=NEW.page_id AND content_mode='hosted' AND store_id='l0i') OR NOT EXISTS(SELECT 1 FROM landing_video_assets WHERE id=NEW.id AND landing_page_id=NEW.page_id AND provider='cloudflare_stream') THEN RAISE EXCEPTION 'VSL hosted video owner required'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER vsl_video_owner_guard BEFORE INSERT OR UPDATE ON vsl_video_uploads FOR EACH ROW EXECUTE FUNCTION vsl_video_owner_guard();
COMMIT;

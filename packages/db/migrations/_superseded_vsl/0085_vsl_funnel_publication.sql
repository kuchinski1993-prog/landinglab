-- Immutable VSL funnel releases and VSL-owned public route table.
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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vsl_project_releases_previous_fk') THEN
    ALTER TABLE vsl_project_releases ADD CONSTRAINT vsl_project_releases_previous_fk
      FOREIGN KEY (previous_release_id) REFERENCES vsl_project_releases(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vsl_projects_active_release_fk') THEN
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

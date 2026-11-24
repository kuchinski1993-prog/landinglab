-- VSL funnels are independent of LandingLabs pages. Legacy VSL tables remain intact.
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

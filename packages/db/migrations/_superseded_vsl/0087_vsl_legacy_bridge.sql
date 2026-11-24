-- Legacy hosted pages remain the public source until an operator explicitly publishes a new funnel.
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

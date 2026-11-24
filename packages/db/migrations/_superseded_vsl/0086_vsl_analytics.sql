-- VSL-owned event pipeline; no visitor PII or administrative session data.
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

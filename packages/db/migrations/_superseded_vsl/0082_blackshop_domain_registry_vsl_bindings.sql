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

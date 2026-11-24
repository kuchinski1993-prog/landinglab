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

-- Legacy shape copied from migration 0045_l0i_landing_page_system.sql.
-- This fixture deliberately contains no VSL columns; 0074 must add them.

CREATE TABLE landing_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL DEFAULT 'l0i',
  slug text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL,
  fulfillment_type text NOT NULL,
  html_body text NOT NULL,
  custom_css text,
  media_urls text[] NOT NULL DEFAULT '{}'::text[],
  video_urls text[] NOT NULL DEFAULT '{}'::text[],
  price numeric(12, 2) NOT NULL,
  preview_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landing_pages_store_slug_unique UNIQUE (store_id, slug)
);

CREATE TABLE landing_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landing_page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  domain text NOT NULL UNIQUE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO landing_pages (
  id, store_id, slug, title, status, currency, fulfillment_type, html_body, price, preview_token
) VALUES (
  '11111111-1111-4111-8111-111111111111', 'l0i', 'legacy-vsl-page',
  'Legacy VSL page', 'draft', 'BRL', 'info_product', '<main>legacy</main>', 97.00, 'legacy-preview-token'
);

INSERT INTO landing_domains (id, landing_page_id, domain, role)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'legacy-vsl.example.test', 'active'
);

-- Story 10.1 — Factory pipeline state (brand, domain, shopify provisioning).
-- Pipeline state is the SOURCE OF TRUTH; BullMQ jobs are stateless dispatchers
-- that consult completed_steps for idempotency.

CREATE TABLE IF NOT EXISTS factory_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL,
  owner_email text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  brief jsonb NOT NULL DEFAULT '{}'::jsonb,
  brand_result jsonb,
  domain_result jsonb,
  shopify_result jsonb,
  completed_steps text[] NOT NULL DEFAULT '{}'::text[],
  error text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_factory_jobs_store ON factory_jobs (store_id);
CREATE INDEX IF NOT EXISTS idx_factory_jobs_status ON factory_jobs (status);
CREATE INDEX IF NOT EXISTS idx_factory_jobs_created ON factory_jobs (created_at DESC);

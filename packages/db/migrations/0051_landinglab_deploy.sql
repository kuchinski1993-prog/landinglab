-- ============================================================================
-- Migration 0051 — LandingLab Squad 5 (Deploy)
-- Story: docs/stories/13.8.landinglab-deploy-squad.story.md (AC1-AC5)
--
-- Additive-only:
--   1. New table `landing_deployments`  — one row per deployment attempt
--   2. New column `landing_pages.current_deployment_id` — points to active deployment
--
-- IDS decision: CREATE
--   REUSE search results: `landing_domains` (migration 0045) covers domain
--   registration/DNS metadata for MANUAL/Onda-1 landings only, does not carry
--   deployment lifecycle state (queued → provisioning → published → failed →
--   unpublished) required by Squad 5 orchestrator. `landing_generation_runs`
--   is a squad-run audit trail, not a deployment ledger. Neither table can be
--   ADAPTED without breaking Onda-1 consumers. New table required.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Table landing_deployments
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS landing_deployments (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    landing_page_id      uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
    -- 'subdomain' → {slug}.landinglab.app | 'custom_domain' → operator-owned FQDN
    deployment_type      text NOT NULL,
    -- e.g. 'whitening-strips-en.landinglab.app' or 'whiteningpro.com'
    hostname             text NOT NULL,
    -- 'spaceship' for custom_domain purchases; NULL for subdomain (wildcard DNS)
    dns_provider         text,
    -- Array of applied records: [{ type, name, value, ttl, priority? }]
    dns_records          jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- SSL lifecycle: 'pending' initial → 'provisioned' when Let's Encrypt issues cert → 'failed'
    ssl_status           text NOT NULL DEFAULT 'pending',
    -- Full URL used for health check post-deploy (e.g. 'https://slug.landinglab.app')
    verification_url     text,
    -- Deployment lifecycle:
    --   queued        — row created, worker not yet picked it up
    --   provisioning  — Deploy Chief running (any of the 5 agents)
    --   awaiting_ssl  — custom domain attached, SSL still provisioning (non-blocking)
    --   published     — health check passed, landing live
    --   publish_failed — any agent failed, non-recoverable in this attempt
    --   unpublished   — operator explicitly took landing offline
    deployment_status    text NOT NULL DEFAULT 'queued',
    -- Article IV audit trail: agent_trace (>=1) + dns_setup + ssl_setup +
    -- health_check_results + optional warnings. Validated by Zod runtime.
    deployment_metadata  jsonb,
    -- USD purchase cost (Spaceship). 0 for subdomain (free via wildcard).
    cost_usd             numeric(10,4) NOT NULL DEFAULT 0,
    published_at         timestamptz,
    -- Nullable — set when operator unpublishes; row is kept for audit + republish
    unpublished_at       timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    -- CHECK constraints — enforce enums at DB layer
    CONSTRAINT landing_deployments_deployment_type_check
        CHECK (deployment_type IN ('subdomain', 'custom_domain')),
    CONSTRAINT landing_deployments_ssl_status_check
        CHECK (ssl_status IN ('pending', 'provisioned', 'failed')),
    CONSTRAINT landing_deployments_deployment_status_check
        CHECK (deployment_status IN (
            'queued', 'provisioning', 'awaiting_ssl',
            'published', 'publish_failed', 'unpublished'
        ))
);

-- Unique hostname across ALL deployments (a hostname cannot serve two landings).
-- Enforced as UNIQUE INDEX (not table constraint) so we can safely re-run migration.
CREATE UNIQUE INDEX IF NOT EXISTS idx_landing_deployments_hostname
    ON landing_deployments(hostname);

-- Backoffice query pattern: "latest deployment for landing X by status"
CREATE INDEX IF NOT EXISTS idx_landing_deployments_lp_status
    ON landing_deployments(landing_page_id, deployment_status);

-- ----------------------------------------------------------------------------
-- 2. Extend landing_pages with current_deployment_id (nullable, self-heal safe)
-- ----------------------------------------------------------------------------

ALTER TABLE landing_pages
    ADD COLUMN IF NOT EXISTS current_deployment_id uuid
        REFERENCES landing_deployments(id) ON DELETE SET NULL;

COMMIT;

-- ============================================================================
-- Rollback (manual — Drizzle journal does not auto-revert)
-- ============================================================================
--
-- BEGIN;
-- ALTER TABLE landing_pages DROP COLUMN IF EXISTS current_deployment_id;
-- DROP INDEX IF EXISTS idx_landing_deployments_lp_status;
-- DROP INDEX IF EXISTS idx_landing_deployments_hostname;
-- DROP TABLE IF EXISTS landing_deployments;
-- COMMIT;

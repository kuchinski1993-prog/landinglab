-- Fase 8 — TrustShield email templates (CRUD only; no sending).
-- One row per (store_id, event_key). Templates are edited/toggled in the
-- backoffice; actual delivery depends on an email provider not wired yet.

CREATE TABLE IF NOT EXISTS email_templates (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   text        NOT NULL DEFAULT 'default',
  event_key  text        NOT NULL,
  subject    text        NOT NULL,
  html_body  text        NOT NULL,
  enabled    boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- Upsert key: at most one template per event per store.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_templates_store_event
  ON email_templates (store_id, event_key);

CREATE INDEX IF NOT EXISTS idx_email_templates_store
  ON email_templates (store_id);

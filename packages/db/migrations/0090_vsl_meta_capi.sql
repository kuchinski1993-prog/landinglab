-- Migration 0090: VSL Hosting — registro de envio da Meta Conversions API (VSL-13 Fase A, 2026-10-10)
--
-- Deltas sobre 0086 + 0087 + 0088 + 0089:
--   1. vsl_meta_capi_deliveries — uma linha por (event_id do evento PADRÃO, pixel) enviado/ignorado/falho.
--      Só ids + status + diagnóstico sanitizado: SEM token, SEM IP/User-Agent/fbp/fbc/URL (AC6/AC10).
--      `pending` é o estado transitório entre a reivindicação (antes de chamar a Meta) e o resultado;
--      a UI mostra só sent/failed/skipped.
--   2. Índice único (event_id, pixel_id): idempotência — reenvio do mesmo eventID nunca chama a Meta de novo.
--   3. Índices para a consulta por funil/período e para o expurgo de 30 dias (D5).
--   4. RLS deny-all (padrão 0087).
--
-- Expurgo (D5, 30 dias): feito pela API (apps/api/src/lib/vsl-meta-capi.ts, no máx. 1x/hora por instância, em lotes).
-- Equivalente manual:
--   DELETE FROM vsl_meta_capi_deliveries WHERE created_at < now() - interval '30 days';
--
-- Totalmente idempotente (IF NOT EXISTS). Sem BEGIN/COMMIT.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 0090_vsl_meta_capi.sql
-- Requer 0086, 0087, 0088 e 0089 aplicadas. Rollback: 0090_vsl_meta_capi.rollback.sql

-- Guardrail (mesmo de 0087/0088/0089): RLS deny-all exige role com BYPASSRLS para o backend.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'VSL 0090 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vsl_meta_capi_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  pixel_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES vsl_projects(id) ON DELETE RESTRICT,
  step_id uuid NOT NULL REFERENCES vsl_steps(id) ON DELETE RESTRICT,
  release_id uuid NOT NULL REFERENCES vsl_project_releases(id) ON DELETE RESTRICT,
  event_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  attempts smallint NOT NULL DEFAULT 0,
  http_status smallint,
  fbtrace_id text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsl_meta_capi_deliveries_event_pixel_unique UNIQUE (event_id, pixel_id),
  CONSTRAINT vsl_meta_capi_deliveries_status_check CHECK (status IN ('pending','sent','failed','skipped')),
  CONSTRAINT vsl_meta_capi_deliveries_event_name_check CHECK (event_name IN ('PageView','ViewContent','InitiateCheckout')),
  CONSTRAINT vsl_meta_capi_deliveries_pixel_check CHECK (pixel_id ~ '^[A-Za-z0-9._-]{2,120}$'),
  CONSTRAINT vsl_meta_capi_deliveries_reason_check CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,40}$'),
  CONSTRAINT vsl_meta_capi_deliveries_attempts_check CHECK (attempts BETWEEN 0 AND 2),
  CONSTRAINT vsl_meta_capi_deliveries_http_check CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT vsl_meta_capi_deliveries_diag_check CHECK (
    (fbtrace_id IS NULL OR length(fbtrace_id) <= 100) AND
    (error_code IS NULL OR length(error_code) <= 60) AND
    (error_message IS NULL OR length(error_message) <= 300))
);
CREATE INDEX IF NOT EXISTS vsl_meta_capi_deliveries_project_time_idx ON vsl_meta_capi_deliveries (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vsl_meta_capi_deliveries_created_idx ON vsl_meta_capi_deliveries (created_at);

ALTER TABLE public.vsl_meta_capi_deliveries ENABLE ROW LEVEL SECURITY;

-- Migration 0097: ledger de jobs duráveis — job_runs (Story 18.3)
--
-- Uma linha por (queue, job_key): o histórico do que aconteceu com cada trabalho
-- em segundo plano que adotou @blackshop/jobs (durableProcessor / enqueueDurable).
-- O BullMQ continua sendo o motor (fila, backoff, retry); esta tabela é a fonte
-- da verdade do desfecho: tentativas, lease com fencing, error_code do catálogo
-- (docs/architecture/erros.md) e classificação determinístico × transitório × incerto.
--
-- Estados (CHECK):
--   queued         gravado e entregue ao BullMQ, aguardando execução
--   queued_failed  o enfileiramento falhou (Redis fora) — reconciliável
--                  (apps/worker/src/scripts/reconcile-jobs.ts)
--   running        uma tentativa em andamento (lease_token/lease_until válidos)
--   retrying       a tentativa falhou com erro transitório e o BullMQ vai repetir
--   succeeded      terminou com sucesso
--   failed         erro determinístico ou última tentativa esgotada
--   uncertain      resultado desconhecido no terceiro (não repete; reconciliar)
--   lost           lease vencido sem desfecho (worker morreu) — marcado pelo GC
--
-- Fencing: begin() troca lease_token; heartbeat/succeed/fail só gravam
-- WHERE lease_token = <meu> (worker zumbi não sobrescreve o novo).
-- last_error é sanitizado e limitado a 500 caracteres no código; nunca payload.
-- replay guarda só flags opcionais para o reconcile (ex.: republishToShopify), nunca dados do cliente.
-- correlation_id fica reservado para a story 18.4.
--
-- Retenção: GC com dry-run (apps/worker/src/scripts/gc-job-runs.ts) — sugestão
-- 30 dias para succeeded e 90 dias para failed/uncertain/lost.
--
-- RLS: nasce habilitado e SEM policies (deny-all para anon/authenticated),
-- mesmo padrão da 0092/0095. O backend conecta como `postgres` (BYPASSRLS).
--
-- Também: products.mirror_uncertain_at (QA REQ-002), ver o fim do arquivo.
--
-- Idempotente (IF NOT EXISTS). Rollback: 0097_job_runs.rollback.sql

BEGIN;

-- Guardrail: sem BYPASSRLS o próprio backend ficaria bloqueado na tabela nova.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0097 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "job_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'default',
  "queue" text NOT NULL,
  "job_key" text NOT NULL,
  "job_name" text,
  "state" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 1,
  "lease_token" uuid,
  "lease_until" timestamptz,
  "error_kind" text,
  "error_code" text,
  "last_error" text,
  "correlation_id" text,
  "result" jsonb,
  -- Dados mínimos (flags, nunca dados do cliente) para o reconcile reconstruir o job.
  "replay" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "finished_at" timestamptz,
  CONSTRAINT "job_runs_state_check"
    CHECK ("state" IN ('queued', 'queued_failed', 'running', 'retrying', 'succeeded', 'failed', 'uncertain', 'lost')),
  CONSTRAINT "job_runs_error_kind_check"
    CHECK ("error_kind" IS NULL OR "error_kind" IN ('deterministic', 'transient', 'uncertain')),
  CONSTRAINT "job_runs_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" >= 1),
  CONSTRAINT "job_runs_last_error_len_check" CHECK ("last_error" IS NULL OR char_length("last_error") <= 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_job_runs_queue_job_key"
  ON "job_runs" ("queue", "job_key");
CREATE INDEX IF NOT EXISTS "idx_job_runs_state_lease"
  ON "job_runs" ("state", "lease_until");
CREATE INDEX IF NOT EXISTS "idx_job_runs_queue_state"
  ON "job_runs" ("queue", "state");

ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;

-- QA REQ-002 (Story 18.3): instante do último resultado incerto da Shopify para o produto
-- (productCreate/mutation sem confirmação). A reconciliação não recria o produto nos 2 minutos
-- seguintes quando a busca (tag + SKU) volta vazia — a busca da Shopify indexa com atraso.
-- Limpo quando o publish no mirror termina. Coluna nula sem default: só metadado (tabela quente).
ALTER TABLE IF EXISTS "products" ADD COLUMN IF NOT EXISTS "mirror_uncertain_at" timestamptz;

COMMIT;

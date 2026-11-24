-- Migration 0095: guarda de câmbio — histórico, relatório de sync e trava manual (Épico 0 · story 0.7)
--
-- Achado (auditoria 2026-11-01): o refresh diário do câmbio gravava a taxa do
-- provedor direto em price_rules.exchange_rate (sem validar, sem comparar com a
-- anterior, sem histórico) e reprecificava todos os produtos publicados de uma
-- vez. Esta migration cria a estrutura da guarda:
--
--   1. price_rules.rate_locked  — trava manual por regra (default false).
--   2. fx_rate_history          — uma linha por tentativa de mudança por regra
--                                 (aplicada, aguardando aprovação, rejeitada,
--                                 inválida, travada, erro do provedor).
--   3. fx_sync_runs             — relatório do sync de preço em massa, limitado
--                                 por execução (planejados, enfileirados,
--                                 alterados, inalterados, falhas, restantes).
--
-- price_rules.exchange_rate continua sendo a fonte do valor VIGENTE; nenhuma
-- leitura existente (storefront, price-sync, import) muda de tabela.
--
-- RLS: as duas tabelas novas nascem com RLS habilitado e SEM policies (deny-all
-- para anon/authenticated), mesmo padrão da 0092. O backend conecta como
-- `postgres` (BYPASSRLS) e não é afetado.
--
-- Coluna nova em tabela quente (price_rules): ADD COLUMN com DEFAULT constante
-- e NOT NULL é só metadado no Postgres 11+ (sem reescrever a tabela).
--
-- Rollback: 0095_fx_guard.rollback.sql

-- Guardrail: sem BYPASSRLS o próprio backend ficaria bloqueado nas tabelas novas.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0095 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

-- 1. Trava manual por regra
ALTER TABLE "price_rules"
  ADD COLUMN IF NOT EXISTS "rate_locked" boolean NOT NULL DEFAULT false;

-- 2. Histórico de câmbio
CREATE TABLE IF NOT EXISTS "fx_rate_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "price_rule_id" uuid REFERENCES "price_rules"("id") ON DELETE SET NULL,
  "store_id" text NOT NULL DEFAULT 'default',
  "source_currency" text NOT NULL,
  "target_currency" text NOT NULL,
  "previous_rate" numeric(10, 6),
  "new_rate" numeric(10, 6),
  "raw_value" text,
  "change_pct" numeric(14, 4),
  "origin" text NOT NULL,
  "provider_date" text,
  "status" text NOT NULL,
  "error_code" text,
  "decided_by" text,
  "decided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "fx_rate_history_origin_check"
    CHECK ("origin" IN ('frankfurter', 'manual', 'bootstrap', 'approval')),
  CONSTRAINT "fx_rate_history_status_check"
    CHECK ("status" IN ('applied', 'pending_approval', 'rejected', 'invalid', 'skipped_locked', 'provider_error'))
);

CREATE INDEX IF NOT EXISTS "idx_fx_rate_history_store_created"
  ON "fx_rate_history" ("store_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_fx_rate_history_rule_status"
  ON "fx_rate_history" ("price_rule_id", "status");
-- No máximo UMA pendência aberta por regra (a nova substitui a antiga na mesma transação).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_fx_rate_history_one_pending_per_rule"
  ON "fx_rate_history" ("price_rule_id")
  WHERE "status" = 'pending_approval';

ALTER TABLE "fx_rate_history" ENABLE ROW LEVEL SECURITY;

-- 3. Relatório do sync de preço em massa
CREATE TABLE IF NOT EXISTS "fx_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'default',
  "trigger" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "dry_run" boolean NOT NULL DEFAULT false,
  "batch_limit" integer NOT NULL,
  "planned" integer NOT NULL DEFAULT 0,
  "queued" integer NOT NULL DEFAULT 0,
  "changed" integer NOT NULL DEFAULT 0,
  "unchanged" integer NOT NULL DEFAULT 0,
  "failed" integer NOT NULL DEFAULT 0,
  "skipped" integer NOT NULL DEFAULT 0,
  "remaining" integer NOT NULL DEFAULT 0,
  "cursor_product_id" uuid,
  -- Chave idempotente do pedido (job BullMQ): retry/duplo clique não cria run duplicado.
  "request_key" text,
  "summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "fx_sync_runs_trigger_check"
    CHECK ("trigger" IN ('fx_refresh', 'approval', 'manual_resync', 'dry_run')),
  CONSTRAINT "fx_sync_runs_status_check"
    CHECK ("status" IN ('running', 'completed', 'partial', 'failed')),
  CONSTRAINT "fx_sync_runs_batch_limit_check" CHECK ("batch_limit" > 0)
);

CREATE INDEX IF NOT EXISTS "idx_fx_sync_runs_store_created"
  ON "fx_sync_runs" ("store_id", "created_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_fx_sync_runs_request_key"
  ON "fx_sync_runs" ("store_id", "request_key")
  WHERE "request_key" IS NOT NULL;

ALTER TABLE "fx_sync_runs" ENABLE ROW LEVEL SECURITY;

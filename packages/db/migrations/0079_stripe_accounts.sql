-- Migration 0079: contas Stripe da LandingLab (Story 15.1)
--
-- Spec: docs/architecture/landinglab-stripe-checkout.md §4.1, §4.5, §4.7
--
-- stripe_accounts: N contas por store, ordenadas por priority (1 = principal).
--   Segredos (sk_/rk_ e whsec_) criptografados na aplicação (AES-256-GCM,
--   packages/vault/src/crypto.ts) — mesmo esquema de credentials.
-- stripe_webhook_events: idempotência dos webhooks (stripe_event_id único).
-- landing_orders: colunas para atribuir o pedido à conta e somar o volume
--   diário na moeda de saque da conta (balance_transaction da Stripe).
--
-- RLS habilitado sem policies (padrão 0076): acesso só via Drizzle superuser.
-- Rollback: 0079_stripe_accounts.rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "stripe_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'l0i',
  "nickname" text NOT NULL,
  "priority" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  "mode" text NOT NULL,
  "publishable_key" text NOT NULL,
  "secret_key_enc" bytea NOT NULL,
  "secret_key_iv" bytea NOT NULL,
  "secret_key_salt" bytea NOT NULL,
  "webhook_secret_enc" bytea,
  "webhook_secret_iv" bytea,
  "webhook_secret_salt" bytea,
  "stripe_account_ref" text,
  "default_currency" text,
  "charges_enabled" boolean,
  "daily_limit_minor" bigint,
  "checkout_domain" text,
  "test_status" text,
  "test_message" text,
  "last_tested_at" timestamptz,
  "last_webhook_at" timestamptz,
  "limit_notified_on" date,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stripe_accounts_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "stripe_accounts_mode_check" CHECK ("mode" IN ('test', 'live')),
  CONSTRAINT "stripe_accounts_test_status_check"
    CHECK ("test_status" IS NULL OR "test_status" IN ('ok', 'error')),
  CONSTRAINT "stripe_accounts_daily_limit_check"
    CHECK ("daily_limit_minor" IS NULL OR "daily_limit_minor" > 0),
  CONSTRAINT "stripe_accounts_priority_check" CHECK ("priority" >= 1)
);

CREATE INDEX IF NOT EXISTS "idx_stripe_accounts_store_priority"
  ON "stripe_accounts" ("store_id", "priority");

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "stripe_event_id" text NOT NULL,
  "stripe_account_id" uuid NOT NULL REFERENCES "stripe_accounts"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "livemode" boolean NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "processed_at" timestamptz,
  "error" text,
  "received_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_stripe_webhook_events_event"
  ON "stripe_webhook_events" ("stripe_event_id");
CREATE INDEX IF NOT EXISTS "idx_stripe_webhook_events_account"
  ON "stripe_webhook_events" ("stripe_account_id", "received_at");

-- FK sem CASCADE de propósito: remover conta não pode apagar rastro financeiro.
ALTER TABLE "landing_orders"
  ADD COLUMN IF NOT EXISTS "stripe_account_id" uuid REFERENCES "stripe_accounts"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "amount_settlement_minor" bigint,
  ADD COLUMN IF NOT EXISTS "settlement_currency" text,
  ADD COLUMN IF NOT EXISTS "paid_at" timestamptz;

CREATE INDEX IF NOT EXISTS "idx_landing_orders_stripe_account_paid"
  ON "landing_orders" ("stripe_account_id", "paid_at")
  WHERE "stripe_account_id" IS NOT NULL;

ALTER TABLE "stripe_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stripe_webhook_events" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE stripe_accounts
  IS 'Contas Stripe da LandingLab (Story 15.1). Segredos criptografados na aplicação; nunca expor *_enc/*_iv/*_salt.';
COMMENT ON COLUMN stripe_accounts.daily_limit_minor
  IS 'Limite diário em unidade mínima de default_currency. NULL = sem limite. Ao atingir: rotaciona (2+ contas) ou continua cobrando e notifica (D2).';
COMMENT ON COLUMN landing_orders.amount_settlement_minor
  IS 'Valor do pedido convertido na moeda de saque da conta Stripe (balance_transaction.amount). Base do volume diário.';

COMMIT;

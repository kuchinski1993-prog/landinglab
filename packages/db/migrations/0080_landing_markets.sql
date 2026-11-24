-- Migration 0080: mercados da LandingLab + provider de checkout por landing (Story 15.2)
--
-- Spec: docs/architecture/landinglab-stripe-checkout.md §4.2, §4.3 (D8, D9, D12, D19)
--
-- landing_markets: país(es) → idioma, moeda, frete (grátis/expresso) e prazos.
--   Cada landing escolhe um mercado e herda tudo dele; landing_pages.currency
--   passa a ser sincronizada a partir do mercado (fonte única de moeda).
-- landing_pages.checkout_provider: 'shopify' (padrão — landings atuais não
--   mudam) | 'stripe'. Decidido no servidor (story 15.3).
--
-- RLS habilitado sem policies (padrão 0076).
-- Rollback: 0080_landing_markets.rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "landing_markets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'l0i',
  "name" text NOT NULL,
  "country_codes" text[] NOT NULL DEFAULT '{}'::text[],
  "locale" text NOT NULL,
  "currency" text NOT NULL,
  "shipping_free_enabled" boolean NOT NULL DEFAULT true,
  "shipping_free_label" text NOT NULL,
  "shipping_free_min_days" integer NOT NULL,
  "shipping_free_max_days" integer NOT NULL,
  "shipping_express_enabled" boolean NOT NULL DEFAULT true,
  "shipping_express_label" text NOT NULL,
  "shipping_express_minor" bigint NOT NULL DEFAULT 0,
  "shipping_express_min_days" integer NOT NULL,
  "shipping_express_max_days" integer NOT NULL,
  "preferred_stripe_account_id" uuid REFERENCES "stripe_accounts"("id") ON DELETE SET NULL,
  "policies" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "landing_markets_status_check" CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "landing_markets_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "landing_markets_locale_check" CHECK ("locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  CONSTRAINT "landing_markets_countries_check" CHECK (cardinality("country_codes") >= 1),
  CONSTRAINT "landing_markets_express_minor_check" CHECK ("shipping_express_minor" >= 0),
  CONSTRAINT "landing_markets_free_days_check"
    CHECK ("shipping_free_min_days" >= 0 AND "shipping_free_max_days" >= "shipping_free_min_days"),
  CONSTRAINT "landing_markets_express_days_check"
    CHECK ("shipping_express_min_days" >= 0 AND "shipping_express_max_days" >= "shipping_express_min_days"),
  CONSTRAINT "landing_markets_some_shipping_check"
    CHECK ("shipping_free_enabled" OR "shipping_express_enabled")
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_markets_store_name"
  ON "landing_markets" ("store_id", lower("name"));

ALTER TABLE "landing_pages"
  ADD COLUMN IF NOT EXISTS "market_id" uuid REFERENCES "landing_markets"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "checkout_provider" text NOT NULL DEFAULT 'shopify';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_checkout_provider_check'
  ) THEN
    ALTER TABLE "landing_pages"
      ADD CONSTRAINT "landing_pages_checkout_provider_check"
      CHECK ("checkout_provider" IN ('shopify', 'stripe'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_landing_pages_market" ON "landing_pages" ("market_id")
  WHERE "market_id" IS NOT NULL;

ALTER TABLE "landing_markets" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE landing_markets
  IS 'Mercados LandingLab (Story 15.2): país → idioma, moeda, frete e prazos. Landing herda via landing_pages.market_id.';
COMMENT ON COLUMN landing_markets.shipping_express_minor
  IS 'Valor do frete expresso em unidade mínima de currency (JPY: 1500 = ¥1.500).';
COMMENT ON COLUMN landing_pages.checkout_provider
  IS 'shopify (padrão) | stripe. Decidido no servidor; trocar só após checklist (conta ativa, mercado, frete, preços).';

COMMIT;

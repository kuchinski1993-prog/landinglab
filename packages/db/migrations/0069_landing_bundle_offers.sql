-- Migration 0069 — Bundle Engine V2 (set/2026)
--
-- Nova tabela `landing_bundle_offers` — armazena as ofertas de bundle
-- detectadas ao clonar (via adapters) OU editadas pelo painel. Substitui
-- dependência dos scripts de bundle apps do concorrente (Kaching, Bundler,
-- Vitals, etc) que consultam a loja original em runtime.
--
-- Runtime storefront lê essa tabela e injeta window.__LL_BUNDLE_OFFERS__
-- no <head>. Script universal no HTML clonado popula data-ll-* nos cards
-- preservados do layout original.
--
-- Feature flag: landing_pages.use_new_bundle_engine (default false) —
-- Bepurex e landings antigas continuam no fluxo antigo até migradas.

CREATE TABLE IF NOT EXISTS landing_bundle_offers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landing_page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  position     integer NOT NULL,
  title        text NOT NULL DEFAULT '',
  qty          integer NOT NULL DEFAULT 1,
  -- Preço + compare em cents (unidade da moeda da landing).
  price_cents  integer NOT NULL DEFAULT 0,
  compare_at_cents integer,
  save_text    text,
  badge        text,
  variant_id   text,
  is_preselected boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE(landing_page_id, position)
);

CREATE INDEX IF NOT EXISTS idx_landing_bundle_offers_landing
  ON landing_bundle_offers(landing_page_id, position);

-- Feature flag na landing_pages: nova engine só ativa após adapter rodar
-- com sucesso. Bepurex/legacy ficam false.
ALTER TABLE landing_pages
  ADD COLUMN IF NOT EXISTS use_new_bundle_engine boolean NOT NULL DEFAULT false;

-- Metadata do adapter que detectou os bundles (kaching, generic, manual, none).
ALTER TABLE landing_pages
  ADD COLUMN IF NOT EXISTS bundle_adapter text,
  ADD COLUMN IF NOT EXISTS bundle_adapter_notes text;

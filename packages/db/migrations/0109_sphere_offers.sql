-- Migration 0109: Catálogo de Ofertas Sphere (Story 16.1, Epic 16 — Fase 1)
--
-- Numeração: 0109 = próximo livre conferindo TODAS as branches/worktrees
-- (origin/main vai até 0108_custom_fields; VSL ocupa 0086-0090). Nesta branch
-- (feat/15.7-checkout-branding) o último arquivo é 0085 — renumerar no merge
-- se outra migration entrar antes.
--
-- Tabelas NOVAS e isoladas (nenhuma tabela/coluna/FK LandingLab ou VSL é
-- alterada nem referenciada; sem FK para tabelas existentes):
--   sphere_offer_programs  — programa do Sphere (slug, nicho, país, moeda,
--                            ref_code, comissão, kind vsl|dtc derivado).
--                            Idempotência do import: UNIQUE (store_id, slug).
--   sphere_offer_funnels   — funis do programa. Idempotência: UNIQUE
--                            (program_id, funnel_key), onde funnel_key é coluna
--                            GERADA = 'id:'||external_id, ou 'name:'||lower(btrim(name))
--                            quando o export não traz id.
--   sphere_offer_materials — steps do funil: type vsl|file|checkout, url como
--                            veio, pots 1/3/5 (só checkout), fn opcional.
--                            Idempotência: UNIQUE (funnel_id, type, url).
-- Cascata: apagar programa apaga funis; apagar funil apaga materiais.
-- Escopo: store_id text DEFAULT 'l0i' sem FK (mesmo padrão das tabelas LandingLab).
-- raw jsonb: payload importado já SANEADO pelo Zod (nunca cookies/tokens/headers).
-- Valores monetários como vieram + currency (sem câmbio nesta fase).
--
-- RLS: nasce habilitado e SEM policies (deny-all para anon/authenticated),
-- padrão 0076/0092. O backend conecta como `postgres` (BYPASSRLS) — guardrail.
-- Idempotente (IF NOT EXISTS). NÃO APLICAR sem aprovação explícita do owner.
-- Rollback: 0109_sphere_offers.rollback.sql (APAGA o catálogo inteiro).

BEGIN;

DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0109 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "sphere_offer_programs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'l0i',
  "slug" text NOT NULL,
  "external_id" text,
  "title" text NOT NULL,
  "niche" text,
  "country" text,
  "currency" text,
  "ref_code" text,
  "commission" numeric(12, 2),
  "default_landing_page_url" text,
  "kind" text NOT NULL,
  "raw" jsonb,
  "imported_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sphere_offer_programs_kind_check" CHECK ("kind" IN ('vsl', 'dtc')),
  CONSTRAINT "sphere_offer_programs_slug_check" CHECK ("slug" ~ '^[a-z0-9][a-z0-9_-]*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_sphere_offer_programs_slug"
  ON "sphere_offer_programs" ("store_id", "slug");
CREATE INDEX IF NOT EXISTS "idx_sphere_offer_programs_niche"
  ON "sphere_offer_programs" ("store_id", "niche");
CREATE INDEX IF NOT EXISTS "idx_sphere_offer_programs_country"
  ON "sphere_offer_programs" ("store_id", "country");
CREATE INDEX IF NOT EXISTS "idx_sphere_offer_programs_kind"
  ON "sphere_offer_programs" ("store_id", "kind");

CREATE TABLE IF NOT EXISTS "sphere_offer_funnels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "program_id" uuid NOT NULL REFERENCES "sphere_offer_programs"("id") ON DELETE CASCADE,
  "store_id" text NOT NULL DEFAULT 'l0i',
  "external_id" text,
  "name" text NOT NULL,
  "funnel_key" text GENERATED ALWAYS AS (
    COALESCE('id:' || "external_id", 'name:' || lower(btrim("name")))
  ) STORED,
  "commission" numeric(12, 2),
  "expected_cpa" numeric(12, 2),
  "avg_paid_order_rate" numeric(9, 4),
  "position" integer NOT NULL DEFAULT 0,
  "raw" jsonb,
  "imported_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Também serve de índice para program_id (coluna líder).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_sphere_offer_funnels_key"
  ON "sphere_offer_funnels" ("program_id", "funnel_key");

CREATE TABLE IF NOT EXISTS "sphere_offer_materials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "funnel_id" uuid NOT NULL REFERENCES "sphere_offer_funnels"("id") ON DELETE CASCADE,
  "store_id" text NOT NULL DEFAULT 'l0i',
  "type" text NOT NULL,
  "title" text,
  "url" text NOT NULL,
  "pots" smallint,
  "fn" text,
  "position" integer NOT NULL DEFAULT 0,
  "raw" jsonb,
  "imported_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sphere_offer_materials_type_check" CHECK ("type" IN ('vsl', 'file', 'checkout')),
  CONSTRAINT "sphere_offer_materials_pots_check"
    CHECK ("pots" IS NULL OR ("type" = 'checkout' AND "pots" IN (1, 3, 5))),
  CONSTRAINT "sphere_offer_materials_fn_check" CHECK ("fn" IS NULL OR "type" = 'checkout'),
  -- Mantém a chave única (funnel_id, type, url) dentro do limite do btree.
  CONSTRAINT "sphere_offer_materials_url_check" CHECK (length("url") BETWEEN 1 AND 2048)
);

-- Também serve de índice para funnel_id (coluna líder).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_sphere_offer_materials_identity"
  ON "sphere_offer_materials" ("funnel_id", "type", "url");

ALTER TABLE "sphere_offer_programs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sphere_offer_funnels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sphere_offer_materials" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE sphere_offer_programs
  IS 'Catálogo Sphere (Story 16.1): programa. Import idempotente por (store_id, slug). Nunca guarda sessão/credencial do Sphere.';
COMMENT ON TABLE sphere_offer_funnels
  IS 'Catálogo Sphere (Story 16.1): funil do programa. Idempotência por (program_id, funnel_key gerado).';
COMMENT ON TABLE sphere_offer_materials
  IS 'Catálogo Sphere (Story 16.1): material/step (vsl|file|checkout). Idempotência por (funnel_id, type, url).';

COMMIT;

-- Migration 0037 — product_pairings (Wave 2 do enriquecimento da PDP).
--
-- Curadoria manual do bloco product-pair-well-with: o dono seleciona,
-- para cada produto, as peças "que combinam". Diferente de product-related
-- (algorítmico); este é editorial.
--
-- Constraints:
--  - PK composta (product_id, paired_product_id) impede duplicata da mesma
--    associação para o mesmo produto.
--  - CHECK (product_id <> paired_product_id) impede auto-associação.
--  - ON DELETE CASCADE em ambos os lados: se qualquer um dos produtos for
--    apagado, as pairings correspondentes somem.
--
-- Idempotente (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
-- Aditiva pura — nenhum drop, nenhum alter em tabelas existentes.

CREATE TABLE IF NOT EXISTS "product_pairings" (
  "product_id"        uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "paired_product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "position"          integer NOT NULL DEFAULT 0,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("product_id", "paired_product_id"),
  CHECK ("product_id" <> "paired_product_id")
);

CREATE INDEX IF NOT EXISTS "idx_product_pairings_product"
  ON "product_pairings" ("product_id", "position");

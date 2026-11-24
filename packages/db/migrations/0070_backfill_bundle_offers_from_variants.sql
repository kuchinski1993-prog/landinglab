-- Migration 0070 — Backfill idempotente landing_variants → landing_bundle_offers
--
-- Contexto: Fase 3 do Landing Lab Stabilization Roadmap (25/09/2026).
-- UI edita landing_bundle_offers, worker apply-bundle lê landing_variants.
-- Divergência causa preços velhos na landing publicada.
--
-- Esta migration garante que TODA landing_variant tenha equivalente em
-- landing_bundle_offers, permitindo que o worker migre pra dual-read
-- (Fase 4) sem quebrar landings legacy.
--
-- SAFETY:
--   - Idempotente: usa WHERE NOT EXISTS pra não sobrescrever bundle_offers existentes
--   - Rastreável: nova coluna __backfill_source registra origem ("migration_0070")
--   - Reversível: DELETE WHERE __backfill_source = 'migration_0070' desfaz
--   - Não toca landing_variants (dados preservados)
--
-- ESTADO REAL (medido em 25/09/2026 antes de aplicar):
--   - Total landing_variants rows: 0
--   - Total landings com bundle_offers: 1
--   - Backfill hoje = no-op, mas protege fluxo `from-clone` futuro que
--     ainda popula landing_variants.

-- ─────────────────────────────────────────────────────────────────────
-- Step 1: adicionar coluna de tracking (rollback-safe)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE landing_bundle_offers
  ADD COLUMN IF NOT EXISTS __backfill_source text;

-- ─────────────────────────────────────────────────────────────────────
-- Step 2: backfill — só landings que NÃO têm bundle_offers ainda
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO landing_bundle_offers (
  landing_page_id,
  position,
  title,
  qty,
  price_cents,
  compare_at_cents,
  variant_id,
  is_preselected,
  __backfill_source
)
SELECT
  lv.landing_page_id,
  lv.sort_order AS position,
  COALESCE(NULLIF(lv.name, ''), 'Bundle ' || (lv.sort_order + 1)) AS title,
  COALESCE(lv.quantity_of_items, 1) AS qty,
  -- price é numeric — converte pra cents (multiplica por 100, arredonda)
  COALESCE(ROUND(lv.price * 100), 0)::integer AS price_cents,
  -- compare_at_price nullable — se null, mantém null
  CASE
    WHEN lv.compare_at_price IS NULL THEN NULL
    ELSE ROUND(lv.compare_at_price * 100)::integer
  END AS compare_at_cents,
  -- variant_id: extrai mirror_variant_id (GID Shopify) via join
  -- em product_variants se disponível
  (SELECT pv.mirror_variant_id
   FROM product_variants pv
   WHERE pv.id = lv.product_variant_id
   LIMIT 1) AS variant_id,
  -- is_preselected: primeira variant (sort_order = 0) marca como preselected
  (lv.sort_order = 0) AS is_preselected,
  'migration_0070' AS __backfill_source
FROM landing_variants lv
WHERE NOT EXISTS (
  SELECT 1 FROM landing_bundle_offers bo
  WHERE bo.landing_page_id = lv.landing_page_id
);

-- ─────────────────────────────────────────────────────────────────────
-- ROLLBACK (execute manualmente se necessário):
-- ─────────────────────────────────────────────────────────────────────
-- DELETE FROM landing_bundle_offers WHERE __backfill_source = 'migration_0070';
-- ALTER TABLE landing_bundle_offers DROP COLUMN __backfill_source;

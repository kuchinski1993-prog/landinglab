-- Migration 0062 — landing_pages.landing_kind + parent_sales_page_id
--
-- Reorganiza landings em 2 tipos claros pro wizard de fluxo:
--   - advertorial: página de conteúdo que aquece o lead (sem produto próprio,
--     aponta pra sales_page via parent_sales_page_id + slug)
--   - sales_page: página de oferta com produto Shopify vinculado (variantes,
--     preço, botão comprar → checkout Shopify)
--   - unknown: rows legadas que ainda não foram classificadas
--
-- parent_sales_page_id: FK opcional que advertorial usa pra apontar pra sua
-- sales_page pai. Permite que CTAs "Continue lendo" / "Saiba mais" do
-- advertorial resolvam a URL da sales page dinamicamente na hora do render.
--
-- IMPORTANTE: não confundir com parent_landing_page_id (já existente, migration
-- 0050) que é semanticamente diferente — aquele vincula VARIANTES DE IDIOMA
-- da mesma landing (EN=base, IT/DE/FR/ES apontam pra EN). Este é pra vincular
-- ADVERTORIAL → SALES PAGE.
--
-- Article IV: schema aceita, app valida (Zod) antes de INSERT/UPDATE.

ALTER TABLE landing_pages
  ADD COLUMN IF NOT EXISTS landing_kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (landing_kind IN ('advertorial', 'sales_page', 'unknown'));

ALTER TABLE landing_pages
  ADD COLUMN IF NOT EXISTS parent_sales_page_id UUID
    REFERENCES landing_pages(id) ON DELETE SET NULL;

-- Índice parcial: query comum é "quais advertoriais apontam pra esta sales?"
CREATE INDEX IF NOT EXISTS idx_landing_pages_parent_sales
  ON landing_pages (parent_sales_page_id)
  WHERE parent_sales_page_id IS NOT NULL;

-- Índice parcial pra filtro por kind (dashboard, listagens agrupadas).
CREATE INDEX IF NOT EXISTS idx_landing_pages_kind
  ON landing_pages (store_id, landing_kind)
  WHERE landing_kind != 'unknown';

COMMENT ON COLUMN landing_pages.landing_kind IS
  'Tipo semântico: advertorial (aquece lead) | sales_page (oferta com produto) | unknown (legado). Wizard usa pra decidir quais steps mostrar.';

COMMENT ON COLUMN landing_pages.parent_sales_page_id IS
  'FK opcional que advertorial usa pra apontar pra sua sales_page pai. Permite CTA "Continue lendo" resolver URL dinamicamente. NÃO confundir com parent_landing_page_id (variantes de idioma). NULL em sales_pages e advertoriais órfãos.';

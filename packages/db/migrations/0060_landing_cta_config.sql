-- Migration 0060 — landing_pages.cta_config
--
-- Adiciona coluna JSONB opcional pra guardar configuração de reescrita de
-- CTAs (Call-To-Action links) do cloner. Populada pela feature "Configurar
-- botões (CTAs)" do backoffice.
--
-- Shape esperado (validado no app via Zod):
-- {
--   "mappings": [
--     {
--       "selector": "a[href='https://vigoraxi.com/products/xxx']:nth-of-type(1)",
--       "originalHref": "https://vigoraxi.com/products/xxx",
--       "newHref": "https://blackshop.com/products/yyy",
--       "category": "sale" | "nav" | "internal" | "external" | "placeholder"
--     }
--   ],
--   "lastRewriteAt": "2026-09-10T12:34:56Z"
-- }
--
-- Nullable: rows pré-feature e landings sem CTAs configurados permanecem NULL.
-- Sem CHECK constraint na estrutura — validação fica no app pra evolução
-- rápida (Constitution Article IV: schema aceita, app valida).

ALTER TABLE landing_pages
  ADD COLUMN IF NOT EXISTS cta_config JSONB;

COMMENT ON COLUMN landing_pages.cta_config IS
  'Snapshot da última configuração de CTA rewrite. NULL = nunca configurado. Shape: {mappings:[{selector, originalHref, newHref, category}], lastRewriteAt}.';

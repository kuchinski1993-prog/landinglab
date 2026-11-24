-- Migration 0075 — landing_pages.landing_kind: adiciona 'pdp_derived'
--
-- Fase 11.1 do roadmap Landing Lab. Reconcilia CHECK constraint com o
-- enum PageFamily existente em packages/landinglab-adapters (que já tem
-- 'pdp_derived' desde a Fase 10.2 mas nunca foi aplicado no DB).
--
-- pdp_derived = Product Detail Page derivada: PDP Shopify (ou similar)
-- transformada em landing independente. Feature completa (classifier +
-- strip layer) fica pra fase futura. Nesta migration APENAS reconciliamos
-- o CHECK constraint para permitir o valor.
--
-- Nenhum renderer runtime consome pdp_derived nesta fase. Storefront,
-- worker apply-bundle e editor tratam pdp_derived como sales_page-like
-- ATÉ que família própria receba tratamento diferenciado (fase futura).
--
-- ROLLBACK: DROP CONSTRAINT + ADD CONSTRAINT com valores originais
-- (advertorial|sales_page|unknown). Rollback é seguro se nenhuma row
-- foi setada para 'pdp_derived' — feito antes de qualquer código
-- escrever esse valor.
--
-- Article IV: schema aceita, app valida (Zod) antes de INSERT/UPDATE.

BEGIN;

-- 1. Drop constraint antigo (nome default gerado pela migration 0062)
ALTER TABLE landing_pages
  DROP CONSTRAINT IF EXISTS landing_pages_landing_kind_check;

-- 2. Recria CHECK com pdp_derived incluído
ALTER TABLE landing_pages
  ADD CONSTRAINT landing_pages_landing_kind_check
    CHECK (landing_kind IN ('advertorial', 'sales_page', 'pdp_derived', 'unknown'));

COMMIT;

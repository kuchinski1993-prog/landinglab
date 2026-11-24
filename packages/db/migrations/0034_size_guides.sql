-- Migration 0034 — Size Guides (Fase D do TrustShield).
--
-- Guias de tamanho reutilizáveis: o dono cria quantos precisar (nome
-- livre, ex.: "Shirts", "Trousers", "Sets"), cada um contendo uma tabela
-- de medidas por tamanho. Cada produto pode apontar para UM guia via
-- products.size_guide_id (dropdown na UI). O toggle products.show_size_table
-- (já existente) controla se o link "Size Guide" / "Find your fit"
-- aparece na página do produto.
--
-- Aditiva. Sem drops. Migration idempotente por defensive `IF NOT EXISTS`.

CREATE TABLE IF NOT EXISTS "size_guides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'default',
  -- Nome livre dado pelo dono (ex.: "Shirts", "Trousers", "Sets/Co-ords").
  "name" text NOT NULL,
  -- Notas opcionais (ex.: "measured flat, add 1 cm for stretch fabrics").
  "notes" text,
  -- Tabela de medidas como JSONB — permite estrutura flexível (colunas
  -- por marca / tipo). Shape esperado, validado no backend:
  -- {
  --   "columns": ["size", "chest", "waist", "hip", "height", "weight"],
  --   "rows": [
  --     { "size": "S",  "chest": "88-92",  "waist": "72-76", "hip": "90-94",  "height": "165-172", "weight": "60-70" },
  --     { "size": "M",  "chest": "92-96",  "waist": "76-80", ... },
  --     ...
  --   ],
  --   "unit": "cm" | "in"
  -- }
  -- Faixas ("88-92") são strings — o motor de recomendação parseia
  -- números do inicio/fim para o match determinístico.
  "table" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_size_guides_store"
  ON "size_guides" ("store_id");

-- Coluna nova em products: FK opcional para o guia associado. Não é
-- notnull — produtos sem guia (acessórios etc.) continuam válidos, e a
-- combinação com products.show_size_table controla a exibição no
-- storefront (toggle desligado OU sem guide → link não aparece).
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "size_guide_id" uuid
    REFERENCES "size_guides"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_products_size_guide"
  ON "products" ("size_guide_id");

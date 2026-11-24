-- Migration 0108: campos personalizados de produto por loja ("Universo da peça") (Story 23.4)
--
-- Numeração PROVISÓRIA: depois da 0106 (23.2) e da 0107 (23.3), na ordem de merge 23.2 → 23.3 → 23.4.
-- O DDL não depende delas; a SEMENTE depende da linha `soulrya` da 0106 (sem ela, nada é semeado —
-- use o script apps/api/src/scripts/seed-custom-fields.ts com STORE_ID=soulrya). Renumerar no merge
-- se outra onda entrar antes.
--
-- Tabelas (nenhuma tabela existente é alterada):
--   store_custom_fields   — definição por loja: key (imutável depois de usada), label, type
--                           (text | long_text | color | number | list), options (lista), is_public,
--                           position. UNIQUE (store_id, key). Até 20 por loja (limite na API).
--   product_custom_values — valor por produto × definição (sempre text, validado por tipo na API).
--                           PK (product_id, field_id). Sem store_id: a API confere que produto e
--                           definição são da loja do request (obrigatório — R3 da story).
-- Cascata: apagar loja/definição/produto apaga os valores.
--
-- RLS: nasce habilitado e SEM policies (deny-all para anon/authenticated), padrão 0100/0104.
-- O backend conecta como `postgres` (BYPASSRLS) — guardrail abaixo.
-- Idempotente (IF NOT EXISTS / ON CONFLICT DO NOTHING; a semente não sobrescreve edição do owner).
-- Ordem de deploy: esta migration → API. Sem ela, a vitrine segue sem `custom_fields` (a leitura
-- pública tolera a tabela ausente) e as rotas do painel respondem erro.
-- Rollback: 0108_custom_fields.rollback.sql (APAGA definições e valores).

BEGIN;

DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0108 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "store_custom_fields" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "type" text NOT NULL,
  "options" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_public" boolean NOT NULL DEFAULT true,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "store_custom_fields_store_key_unique" UNIQUE ("store_id", "key"),
  CONSTRAINT "store_custom_fields_type_check" CHECK ("type" IN ('text', 'long_text', 'color', 'number', 'list')),
  CONSTRAINT "store_custom_fields_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT "store_custom_fields_label_check" CHECK (char_length("label") BETWEEN 1 AND 80),
  CONSTRAINT "store_custom_fields_options_check" CHECK (jsonb_typeof("options") = 'array')
);

CREATE INDEX IF NOT EXISTS "idx_store_custom_fields_store_position"
  ON "store_custom_fields" ("store_id", "position");

CREATE TABLE IF NOT EXISTS "product_custom_values" (
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "field_id" uuid NOT NULL REFERENCES "store_custom_fields"("id") ON DELETE CASCADE,
  "value" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("product_id", "field_id")
);

CREATE INDEX IF NOT EXISTS "idx_product_custom_values_field" ON "product_custom_values" ("field_id");

ALTER TABLE "store_custom_fields" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_custom_values" ENABLE ROW LEVEL SECURITY;

-- Semente da SOULRYA (decisão 7) — só se a loja existir (0106 ou criada pela tela). Mesma lista do
-- script (apps/api/src/modules/catalogo/lib/custom-fields-seed.ts; teste confere as duas).
INSERT INTO "store_custom_fields" ("store_id", "key", "label", "type", "options", "is_public", "position")
SELECT 'soulrya', v.key, v.label, v.type, v.options::jsonb, true, v.position
  FROM (VALUES
    ('deusa', 'Deusa', 'text', '[]', 0),
    ('elemento', 'Elemento', 'list', '["Terra","Fogo","Água","Ar / Luz","Lua","Sol"]', 1),
    ('faceta', 'Faceta', 'text', '[]', 2),
    ('cor_da_deusa', 'Cor da deusa', 'color', '[]', 3),
    ('invocacao', 'Invocação', 'long_text', '[]', 4),
    ('cristal', 'Cristal', 'text', '[]', 5),
    ('significado_do_cristal', 'Significado do cristal', 'long_text', '[]', 6),
    ('edicao', 'Peças da edição', 'number', '[]', 7)
  ) AS v(key, label, type, options, position)
 WHERE EXISTS (SELECT 1 FROM "stores" WHERE "id" = 'soulrya')
ON CONFLICT ("store_id", "key") DO NOTHING;

COMMIT;

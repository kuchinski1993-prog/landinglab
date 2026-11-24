-- Migration 0100: endereços de suporte por loja — store_support_addresses (Story 17.6b · Atendimento por loja)
--
-- O webhook de entrada (/webhooks/email/inbound) passa a decidir a loja do e-mail pelo
-- destinatário do envelope (`to`, vindo do Cloudflare Email Worker, assinado por HMAC):
--   1. igualdade exata do endereço normalizado (minúsculas, sem `Nome <...>`, sem ponto final);
--   2. sem `+etiqueta` (support+vip@x → support@x);
--   3. padrão de domínio inteiro (`@dominio`);
--   4. nada casa → loja `default` + alerta ao dono (nunca rejeita, nunca descarta).
--
-- `pattern` é PRIMARY KEY GLOBAL: um endereço pertence a UMA loja (duas lojas não podem
-- reivindicar o mesmo endereço). Índice parcial único: no máximo um principal por loja.
-- `pattern` sempre em minúsculas, `local@dominio.tld` ou `@dominio.tld`, ≤ 254 (CHECK).
--
-- Semente = comportamento de hoje: tudo de @authenlondon.com cai na `default`
-- (support@authenlondon.com é o principal). Só semeia se a loja `default` existir.
--
-- RLS: nasce habilitado e SEM policies (deny-all para anon/authenticated), mesmo padrão
-- da 0096/0097. O backend conecta como `postgres` (BYPASSRLS) — guardrail abaixo.
--
-- Ordem de deploy: esta migration → API. A API nova sem esta tabela continua recebendo
-- tudo na `default` (falha de leitura → `default` + log.error, sempre 200).
-- Idempotente (IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- Rollback: 0100_store_support_addresses.rollback.sql (aborta se houver endereço de outra loja).

BEGIN;

-- Guardrail: sem BYPASSRLS o próprio backend ficaria bloqueado na tabela nova.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0100 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "store_support_addresses" (
  "pattern" text PRIMARY KEY,
  "store_id" text NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "is_primary" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "store_support_addresses_pattern_check" CHECK (
    char_length("pattern") <= 254
    AND "pattern" = lower("pattern")
    AND "pattern" ~ '^([a-z0-9!#$%&''*+/=?^_`{|}~.-]+)?@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  ),
  -- O principal é um endereço de verdade (nunca o padrão de domínio).
  CONSTRAINT "store_support_addresses_primary_exact_check" CHECK (NOT "is_primary" OR "pattern" NOT LIKE '@%')
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_store_support_addresses_primary"
  ON "store_support_addresses" ("store_id") WHERE "is_primary";
CREATE INDEX IF NOT EXISTS "idx_store_support_addresses_store"
  ON "store_support_addresses" ("store_id");

ALTER TABLE "store_support_addresses" ENABLE ROW LEVEL SECURITY;

-- Semente: comportamento de hoje da AuthenLondon (loja `default`).
INSERT INTO "store_support_addresses" ("pattern", "store_id", "is_primary")
SELECT v.pattern, 'default', v.is_primary
FROM (VALUES ('support@authenlondon.com', true), ('@authenlondon.com', false)) AS v(pattern, is_primary)
WHERE EXISTS (SELECT 1 FROM "stores" WHERE "id" = 'default')
ON CONFLICT ("pattern") DO NOTHING;

COMMIT;

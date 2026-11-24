-- Migration 0096: registro de módulos por loja (Épico 19 · story 19.3a)
--
-- Cria a forma única de dizer "este módulo existe nesta loja":
--
--   1. store_modules        — uma linha por (loja, módulo) com `enabled`.
--                             AUSÊNCIA DE LINHA = LIGADO (padrão do módulo em
--                             packages/shared/src/modules.ts). Uma loja nova
--                             (POST /stores) já nasce com tudo ligado sem
--                             precisar de linha.
--   2. store_module_events  — trilha de auditoria append-only de cada mudança
--                             (from_enabled → to_enabled, quem, quando).
--
-- Desligar um módulo SÓ esconde o item do menu e a fonte de pendência da home
-- daquela loja. Não bloqueia rota de API, fila nem tabela (Tracker e
-- TrustShield em especial, que são zonas protegidas).
--
-- A lista de ids válidos é validada em código (@blackshop/shared/modules); o
-- CHECK aqui valida só o FORMATO, para não exigir migration a cada módulo novo.
-- `config` é reservado para o Épico 17 e não é lido por ninguém ainda.
--
-- Seed: uma linha enabled = true por loja existente × módulo do registro,
-- reproduzindo explicitamente o estado atual ("tudo ligado"). Idempotente
-- (ON CONFLICT DO NOTHING: rodar duas vezes não duplica nem altera linha já
-- existente). O código NÃO depende do seed.
--
-- RLS: as duas tabelas nascem com RLS habilitado e SEM policies (deny-all para
-- anon/authenticated), mesmo padrão da 0092/0095. O backend conecta como
-- `postgres` (BYPASSRLS) e não é afetado.
--
-- Rollback: 0096_store_modules.rollback.sql

-- Guardrail: sem BYPASSRLS o próprio backend ficaria bloqueado nas tabelas novas.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0096 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

-- 1. Estado por loja
CREATE TABLE IF NOT EXISTS "store_modules" (
  "store_id" text NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "module" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "store_modules_pkey" PRIMARY KEY ("store_id", "module"),
  CONSTRAINT "store_modules_module_format_check" CHECK ("module" ~ '^[a-z][a-z0-9-]{1,40}$')
);

ALTER TABLE "store_modules" ENABLE ROW LEVEL SECURITY;

-- 2. Auditoria (append-only)
CREATE TABLE IF NOT EXISTS "store_module_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "module" text NOT NULL,
  "from_enabled" boolean NOT NULL,
  "to_enabled" boolean NOT NULL,
  "actor" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "store_module_events_module_format_check" CHECK ("module" ~ '^[a-z][a-z0-9-]{1,40}$')
);

CREATE INDEX IF NOT EXISTS "idx_store_module_events_store_created"
  ON "store_module_events" ("store_id", "created_at" DESC);

ALTER TABLE "store_module_events" ENABLE ROW LEVEL SECURITY;

-- 3. Seed "tudo ligado" (estado atual) — mesma lista de packages/shared/src/modules.ts.
INSERT INTO "store_modules" ("store_id", "module", "enabled")
SELECT s."id", m."module", true
FROM "stores" s
CROSS JOIN (VALUES
  ('catalogo'), ('pedidos'), ('loja-online'), ('atendimento'), ('marketing'),
  ('landinglab'), ('vsl'), ('tracker'), ('sistema')
) AS m("module")
ON CONFLICT ("store_id", "module") DO NOTHING;

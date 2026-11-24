-- Migration 0101: contas por e-mail e senha — users, auth_tokens, auth_audit_log (Story 22.1a-1 · Epic 22)
--
-- Substitui (na 22.1a-2/22.1d) a senha única APP_PASSWORD_HASH por usuários com e-mail + senha.
-- Nesta migration as tabelas nascem INERTES: nenhuma rota as lê até a 22.1a-2.
--
--   users           — uma linha por pessoa; cadastro = linha `pending_approval` (não há tabela de
--                     solicitações separada). Papéis v1: owner | member. `password_hash` (argon2id)
--                     é NULL até a pessoa criar a senha pelo link de uso único.
--                     `last_failed_login_at` marca a janela de 15 min do bloqueio progressivo (D6).
--   auth_tokens     — convite/redefinição de senha. SÓ o sha256 (hex) do token fica no banco; uso
--                     único (`used_at`) e expiração (`expires_at`) — o consumo é um UPDATE atômico.
--   auth_audit_log  — trilha APPEND-ONLY (trigger recusa UPDATE/DELETE/TRUNCATE). E-mail só
--                     mascarado; detalhe jsonb nunca leva senha, hash, token, link nem cookie.
--                     A única alteração aceita é o `ON DELETE SET NULL` do FK `subject_user_id`
--                     (o resto da linha precisa continuar idêntico).
--
-- RLS: nasce habilitado e SEM policies (deny-all para anon/authenticated), padrão 0096/0097/0100.
-- O backend conecta como `postgres` (BYPASSRLS) — guardrail abaixo.
-- Aditiva: nenhuma tabela existente é alterada. Idempotente (IF NOT EXISTS / OR REPLACE).
-- Rollback: 0101_auth_users_tokens_audit.rollback.sql (aborta se houver dado além do owner semeado).

BEGIN;

-- Guardrail: sem BYPASSRLS o próprio backend ficaria bloqueado nas tabelas novas.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0101 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

-- 1. Usuários
CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "name" text,
  "role" text NOT NULL DEFAULT 'member',
  "status" text NOT NULL DEFAULT 'pending_approval',
  "password_hash" text,
  "password_changed_at" timestamptz,
  "failed_login_count" integer NOT NULL DEFAULT 0,
  "last_failed_login_at" timestamptz,
  "locked_until" timestamptz,
  "last_login_at" timestamptz,
  "requested_at" timestamptz,
  "request_note" text,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamptz,
  "decision_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "users_email_check" CHECK ("email" = lower("email") AND char_length("email") BETWEEN 3 AND 254 AND "email" LIKE '%_@_%'),
  CONSTRAINT "users_name_check" CHECK ("name" IS NULL OR char_length("name") <= 120),
  CONSTRAINT "users_role_check" CHECK ("role" IN ('owner', 'member')),
  CONSTRAINT "users_status_check" CHECK ("status" IN ('pending_approval', 'approved_pending_password', 'active', 'rejected', 'disabled')),
  CONSTRAINT "users_request_note_check" CHECK ("request_note" IS NULL OR char_length("request_note") <= 280),
  CONSTRAINT "users_decision_reason_check" CHECK ("decision_reason" IS NULL OR char_length("decision_reason") <= 280),
  CONSTRAINT "users_failed_login_count_check" CHECK ("failed_login_count" >= 0),
  -- Conta ativa sempre tem senha (o login nunca compara com NULL).
  CONSTRAINT "users_active_has_password_check" CHECK ("status" <> 'active' OR "password_hash" IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_email_lower" ON "users" (lower("email"));
CREATE INDEX IF NOT EXISTS "idx_users_status" ON "users" ("status");

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;

-- 2. Tokens de convite/redefinição (só o hash)
CREATE TABLE IF NOT EXISTS "auth_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "auth_tokens_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "auth_tokens_purpose_check" CHECK ("purpose" IN ('invite', 'reset')),
  -- sha256 em hex: nunca o token em claro (64 caracteres hex minúsculos).
  CONSTRAINT "auth_tokens_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "auth_tokens_expiry_check" CHECK ("expires_at" > "created_at")
);

CREATE INDEX IF NOT EXISTS "idx_auth_tokens_user_purpose_open"
  ON "auth_tokens" ("user_id", "purpose") WHERE "used_at" IS NULL;

ALTER TABLE "auth_tokens" ENABLE ROW LEVEL SECURITY;

-- 3. Auditoria append-only
CREATE TABLE IF NOT EXISTS "auth_audit_log" (
  "id" bigserial PRIMARY KEY,
  "at" timestamptz NOT NULL DEFAULT now(),
  "event" text NOT NULL,
  "actor_user_id" uuid,
  "subject_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "email_masked" text,
  "ip" text,
  "user_agent" text,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "auth_audit_log_event_check" CHECK ("event" ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT "auth_audit_log_email_masked_check" CHECK ("email_masked" IS NULL OR char_length("email_masked") <= 254),
  CONSTRAINT "auth_audit_log_ip_check" CHECK ("ip" IS NULL OR char_length("ip") <= 200),
  CONSTRAINT "auth_audit_log_user_agent_check" CHECK ("user_agent" IS NULL OR char_length("user_agent") <= 200)
);

CREATE INDEX IF NOT EXISTS "idx_auth_audit_log_subject_at" ON "auth_audit_log" ("subject_user_id", "at");
CREATE INDEX IF NOT EXISTS "idx_auth_audit_log_at" ON "auth_audit_log" ("at");

ALTER TABLE "auth_audit_log" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION auth_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Única exceção: o FK subject_user_id ON DELETE SET NULL (usuário removido). Todo o resto igual.
    -- pg_trigger_depth() > 1 = a alteração vem da ação referencial do FK (trigger RI), nunca de um
    -- UPDATE direto (que roda com profundidade 1) — ninguém "desvincula" uma linha à mão.
    IF pg_trigger_depth() > 1
       AND OLD.subject_user_id IS NOT NULL AND NEW.subject_user_id IS NULL
       AND (to_jsonb(NEW) - 'subject_user_id') = (to_jsonb(OLD) - 'subject_user_id') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'auth_audit_log é append-only: % recusado', TG_OP USING ERRCODE = 'insufficient_privilege';
END $fn$;

DROP TRIGGER IF EXISTS "auth_audit_log_no_update_delete" ON "auth_audit_log";
CREATE TRIGGER "auth_audit_log_no_update_delete"
  BEFORE UPDATE OR DELETE ON "auth_audit_log"
  FOR EACH ROW EXECUTE FUNCTION auth_audit_log_append_only();

DROP TRIGGER IF EXISTS "auth_audit_log_no_truncate" ON "auth_audit_log";
CREATE TRIGGER "auth_audit_log_no_truncate"
  BEFORE TRUNCATE ON "auth_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION auth_audit_log_append_only();

COMMIT;

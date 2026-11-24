-- Migration 0103: sessões por usuário em tabela — auth_sessions (Story 22.1a-1 · Epic 22 · D5)
--
-- Loja de sessão do @fastify/session (plugada na 22.1a-2): sobrevive a deploy/restart e é
-- revogável por usuário (DELETE … WHERE user_id). A chave é sha256(sid) em hex — o banco NUNCA
-- guarda o id que vale como cookie. Nesta migration a tabela nasce INERTE (nenhum código a lê).
--
-- RLS habilitado e SEM policies; guardrail de BYPASSRLS. Depende da 0101. Aditiva e idempotente.
-- Rollback: 0103_auth_sessions.rollback.sql (remove a tabela: todos entram de novo).

BEGIN;

DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0103 aborted: role % lacks BYPASSRLS. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "sid_hash" text PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "data" jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "user_agent" text,
  "ip" text,
  CONSTRAINT "auth_sessions_sid_hash_check" CHECK ("sid_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "auth_sessions_user_agent_check" CHECK ("user_agent" IS NULL OR char_length("user_agent") <= 200),
  CONSTRAINT "auth_sessions_ip_check" CHECK ("ip" IS NULL OR char_length("ip") <= 200)
);

CREATE INDEX IF NOT EXISTS "idx_auth_sessions_user" ON "auth_sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_auth_sessions_expires" ON "auth_sessions" ("expires_at");

ALTER TABLE "auth_sessions" ENABLE ROW LEVEL SECURITY;

COMMIT;

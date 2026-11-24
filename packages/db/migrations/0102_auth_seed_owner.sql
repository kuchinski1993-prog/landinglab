-- Migration 0102: semeia o owner principal (Story 22.1a-1 · Epic 22 · decisão do owner "senha inicial por link")
--
-- Cria kuchinski1993@gmail.com com role = 'owner', status = 'approved_pending_password' e
-- password_hash = NULL: SEM senha utilizável (o login nunca compara com NULL e a CHECK da 0101
-- impede `active` sem senha). Esta migration NÃO cria token nem envia e-mail: o link de criar senha
-- sai depois (22.1a-2: "Esqueci minha senha" ou `pnpm --filter @blackshop/api auth:send-owner-invite`).
-- Até lá o acesso continua pela senha única de hoje (APP_PASSWORD_HASH).
--
-- Depende da 0101. Idempotente (ON CONFLICT no índice único de lower(email) — não toca uma linha
-- que já exista, nem se o owner já tiver criado a senha).
-- Rollback: 0102_auth_seed_owner.rollback.sql (remove só a linha semeada, se ainda sem senha e sem sessão).

BEGIN;

INSERT INTO "users" ("email", "role", "status", "password_hash")
VALUES ('kuchinski1993@gmail.com', 'owner', 'approved_pending_password', NULL)
ON CONFLICT ((lower("email"))) DO NOTHING;

COMMIT;

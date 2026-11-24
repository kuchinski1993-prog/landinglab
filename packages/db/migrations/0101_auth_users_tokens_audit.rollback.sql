-- Rollback da 0101 (Story 22.1a-1): remove users, auth_tokens e auth_audit_log.
--
-- Ordem dos rollbacks: 0103 → 0102 → 0101.
--
-- Nada se perde em silêncio: a checagem roda DENTRO da mesma transação, antes de qualquer alteração,
-- e o bloco DO ABORTA (nada muda) se houver:
--   - qualquer usuário além do owner semeado pela 0102 ainda sem senha
--     (kuchinski1993@gmail.com com password_hash NULL);
--   - qualquer token (convite/redefinição já emitido);
--   - qualquer linha de auditoria;
--   - a tabela auth_sessions (0103) ainda existir — reverta a 0103 antes (ela depende de users).
-- (Num cliente que mantém a sessão — psql interativo —, rode ROLLBACK depois do erro.)
--
-- Rollback do código (API) NÃO exige este rollback: o código de antes ignora as tabelas.

BEGIN;

DO $$
DECLARE
  v_users integer := 0;
  v_tokens integer := 0;
  v_audit integer := 0;
BEGIN
  IF to_regclass('public.auth_sessions') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback da 0101 abortado: auth_sessions (0103) ainda existe. Rode antes 0103_auth_sessions.rollback.sql e 0102_auth_seed_owner.rollback.sql.';
  END IF;

  IF to_regclass('public.users') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_users FROM users
  WHERE NOT (email = 'kuchinski1993@gmail.com' AND password_hash IS NULL);

  IF to_regclass('public.auth_tokens') IS NOT NULL THEN
    SELECT count(*) INTO v_tokens FROM auth_tokens;
  END IF;
  IF to_regclass('public.auth_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM auth_audit_log;
  END IF;
  IF v_users > 0 OR v_tokens > 0 OR v_audit > 0 THEN
    RAISE EXCEPTION 'Rollback da 0101 abortado: há dados de contas que seriam perdidos — % usuário(s) além do owner semeado sem senha, % token(s), % linha(s) de auditoria. Mantenha a 0101 e reverta só o código (a API antiga ignora estas tabelas).', v_users, v_tokens, v_audit;
  END IF;
END $$;

DROP TABLE IF EXISTS "auth_tokens";
DROP TABLE IF EXISTS "auth_audit_log";
DROP FUNCTION IF EXISTS auth_audit_log_append_only();
DROP TABLE IF EXISTS "users";
COMMIT;

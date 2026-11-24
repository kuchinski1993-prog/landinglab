-- Rollback da 0102 (Story 22.1a-1): remove o owner semeado.
--
-- Remove a linha de kuchinski1993@gmail.com SOMENTE se ela ainda estiver como a 0102 deixou:
-- role owner, status approved_pending_password, SEM senha e SEM sessão (auth_sessions, se a 0103
-- existir). Se o owner já criou a senha, mudou de estado ou tem sessão, o rollback ABORTA (nada
-- muda) — apagar trancaria o dono fora sem aviso.
-- Tokens de convite do owner (se houver) caem junto (FK ON DELETE CASCADE); na auditoria o
-- subject_user_id vira NULL (única alteração que o trigger append-only aceita).

BEGIN;

DO $$
DECLARE
  v_id uuid;
  v_ok boolean;
  v_sessions integer := 0;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RETURN;
  END IF;

  SELECT id, (role = 'owner' AND status = 'approved_pending_password' AND password_hash IS NULL)
    INTO v_id, v_ok
  FROM users WHERE email = 'kuchinski1993@gmail.com';

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  IF to_regclass('public.auth_sessions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM auth_sessions WHERE user_id = $1' INTO v_sessions USING v_id;
  END IF;

  IF NOT v_ok OR v_sessions > 0 THEN
    RAISE EXCEPTION 'Rollback da 0102 abortado: o owner kuchinski1993@gmail.com já foi alterado (senha criada, status/papel diferente ou % sessão(ões)). Remover trancaria o dono fora; mantenha a 0102.', v_sessions;
  END IF;

  DELETE FROM users WHERE id = v_id;
END $$;

COMMIT;

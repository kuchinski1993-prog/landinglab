-- Rollback da 0103 (Story 22.1a-1): remove auth_sessions.
--
-- Efeito documentado: todas as sessões por usuário deixam de existir — todo mundo entra de novo.
-- (Na 22.1a-1 nenhuma rota usa a tabela; o login de hoje guarda a sessão em memória.)
-- Na 22.1a-2 em diante: reverta o código ANTES (a loja de sessão lê esta tabela).

BEGIN;
DROP TABLE IF EXISTS "auth_sessions";
COMMIT;

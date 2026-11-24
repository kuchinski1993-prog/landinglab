-- Migration 0099: inbound_emails.message_id único POR LOJA (Story 17.6a · Atendimento por loja)
--
-- Antes: idx_inbound_emails_message_id era UNIQUE global em (message_id) WHERE
-- message_id IS NOT NULL (0023). O webhook já deduplica por loja no SELECT, mas o
-- INSERT batia no índice global: o mesmo Message-ID chegando para a segunda loja
-- (por exemplo um e-mail com os dois endereços de suporte em cópia) era
-- descartado em silêncio como conflict_ignored.
--
-- Expand → contract numa transação curta (inbound_emails é pequena):
--   1. cria o índice único parcial (store_id, message_id) — MAIS permissivo que o
--      antigo: nenhuma linha existente o viola (não aborta por dado);
--   2. remove o índice global. Criação antes do drop, na mesma transação: não há
--      janela sem índice (sem risco de duplicata nem de perda de e-mail).
-- Dentro da mesma loja o Message-ID continua deduplicado (o catch 23505 do
-- webhook passa a valer só para a duplicata real da mesma loja).
--
-- lock_timeout: o CREATE UNIQUE INDEX (sem CONCURRENTLY, que não roda em
-- transação) bloqueia INSERT só durante a construção; o webhook ESPERA, não
-- falha. Se o lock não vier em 5 s a migration aborta inteira e nada muda.
--
-- Ordem de deploy: esta migration → API → worker. O código de antes funciona
-- com o índice novo; o código novo funciona com o índice antigo (só a segunda
-- loja com o mesmo Message-ID fica bloqueada até esta migration).
-- Rollback: 0099_…rollback.sql (só recria o índice global se não houver
-- message_id repetido entre lojas). Rollback do código NÃO exige rollback daqui.

BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE UNIQUE INDEX IF NOT EXISTS "idx_inbound_emails_store_message_id" ON "inbound_emails" USING btree ("store_id", "message_id") WHERE "message_id" IS NOT NULL;
DROP INDEX IF EXISTS "idx_inbound_emails_message_id";
COMMIT;

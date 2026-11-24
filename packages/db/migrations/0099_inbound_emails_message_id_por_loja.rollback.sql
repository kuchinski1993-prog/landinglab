-- Rollback da 0099 (Story 17.6a): volta inbound_emails.message_id a UNIQUE global.
--
-- Só é possível se NENHUM message_id estiver repetido entre lojas. A checagem
-- roda DENTRO da mesma transação, antes de qualquer alteração: se houver
-- repetição, o bloco DO aborta com a lista (até 20 Message-IDs, com as lojas) e o
-- esquema fica intacto. (Num cliente que mantém a sessão — psql interativo —,
-- rode ROLLBACK depois do erro para sair da transação abortada; nada foi aplicado.)
--
-- Rollback do código (API e worker) NÃO exige este rollback: o código de antes
-- funciona com o índice por loja. Se este rollback abortar por repetição entre
-- lojas, mantenha a 0099 e reverta só o código.
--
-- Ordem: checagem → recria idx_inbound_emails_message_id (parcial, como na 0023)
-- → remove o índice por loja.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_total integer;
  v_lista text;
BEGIN
  SELECT count(*) INTO v_total
  FROM (
    SELECT message_id FROM inbound_emails
    WHERE message_id IS NOT NULL
    GROUP BY message_id
    HAVING count(*) > 1
  ) d;

  IF v_total > 0 THEN
    SELECT string_agg(d.message_id || ' (lojas: ' || d.lojas || ')', E'\n' ORDER BY d.message_id) INTO v_lista
    FROM (
      SELECT message_id, string_agg(DISTINCT store_id, ', ' ORDER BY store_id) AS lojas
      FROM inbound_emails
      WHERE message_id IS NOT NULL
      GROUP BY message_id
      HAVING count(*) > 1
      ORDER BY message_id
      LIMIT 20
    ) d;

    RAISE EXCEPTION E'Rollback da 0099 abortado: % message_id repetido(s) entre lojas. Mantenha a 0099 (o código de antes funciona com ela) ou remova as duplicatas entre lojas antes do rollback. Primeiros (até 20):\n%', v_total, v_lista;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_inbound_emails_message_id" ON "inbound_emails" USING btree ("message_id") WHERE "message_id" IS NOT NULL;
DROP INDEX IF EXISTS "idx_inbound_emails_store_message_id";
COMMIT;

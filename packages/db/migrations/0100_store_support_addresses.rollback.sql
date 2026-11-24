-- Rollback da 0100 (Story 17.6b): remove store_support_addresses.
--
-- Só é possível se NENHUM endereço pertencer a uma loja diferente da `default`: removê-los
-- faria os e-mails dessas lojas caírem na `default` (perda de roteamento). A checagem roda
-- DENTRO da mesma transação, antes de qualquer alteração: se houver, o bloco DO aborta com a
-- lista (até 20 endereços, com as lojas) e nada muda. (Num cliente que mantém a sessão — psql
-- interativo —, rode ROLLBACK depois do erro para sair da transação abortada.)
--
-- Rollback do código (API) NÃO exige este rollback: o código de antes ignora a tabela.
-- Sem a tabela, a API da 17.6b manda tudo para a `default` (log.error por e-mail).

BEGIN;

DO $$
DECLARE
  v_total integer;
  v_lista text;
BEGIN
  IF to_regclass('public.store_support_addresses') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_total FROM store_support_addresses WHERE store_id <> 'default';

  IF v_total > 0 THEN
    SELECT string_agg(d.pattern || ' (loja: ' || d.store_id || ')', E'\n' ORDER BY d.pattern) INTO v_lista
    FROM (
      SELECT pattern, store_id FROM store_support_addresses
      WHERE store_id <> 'default'
      ORDER BY pattern
      LIMIT 20
    ) d;

    RAISE EXCEPTION E'Rollback da 0100 abortado: % endereço(s) de suporte de loja diferente da default (os e-mails dessas lojas passariam a cair na default). Remova esses endereços pela API (DELETE /stores/:id/support-addresses/:address) ou mantenha a 0100 e reverta só o código. Primeiros (até 20):\n%', v_total, v_lista;
  END IF;
END $$;

DROP TABLE IF EXISTS "store_support_addresses";
COMMIT;

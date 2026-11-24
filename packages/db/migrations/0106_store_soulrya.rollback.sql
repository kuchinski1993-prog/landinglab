-- Rollback da 0106 (Story 23.2): remove a loja SOULRYA SÓ SE ELA CONTINUAR VAZIA.
--
-- Lojas têm vínculos lógicos por `store_id` em dezenas de tabelas (nem todas com FK). Antes de
-- apagar, o rollback consulta o CATÁLOGO do Postgres (information_schema.columns) e confere TODAS
-- as tabelas do schema public que têm a coluna `store_id`. Se qualquer uma tiver linha com
-- store_id = 'soulrya' (produto, pedido, credencial, tema, módulo...), o rollback ABORTA com
-- RAISE EXCEPTION listando as tabelas — nada é apagado. A linha 'default' nunca é tocada.

BEGIN;

DO $$
DECLARE
  t record;
  found boolean;
  in_use text[] := ARRAY[]::text[];
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'store_id'
       AND tb.table_type = 'BASE TABLE'
     ORDER BY c.table_name
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE store_id::text = $1)', t.table_name)
      INTO found USING 'soulrya';
    IF found THEN
      in_use := in_use || t.table_name::text;
    END IF;
  END LOOP;

  IF array_length(in_use, 1) IS NOT NULL THEN
    RAISE EXCEPTION '0106 rollback aborted: a loja soulrya tem dados em % — nada foi apagado. Remova os dados da loja antes (ou mantenha a loja).',
      array_to_string(in_use, ', ');
  END IF;

  DELETE FROM public.stores WHERE id = 'soulrya';
END $$;

COMMIT;

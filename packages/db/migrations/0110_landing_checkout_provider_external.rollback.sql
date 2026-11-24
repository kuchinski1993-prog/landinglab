-- Rollback da migration 0110 (Story 16.3).
-- Restaura o CHECK original da 0080: checkout_provider IN ('shopify','stripe').
--
-- PROTEGIDO: se existir QUALQUER landing com checkout_provider = 'external',
-- o rollback ABORTA (RAISE EXCEPTION -> transação desfeita, nada muda).
-- Nunca converte nem apaga dados em silêncio. Antes de reexecutar, o operador
-- deve decidir o destino dessas landings, por exemplo:
--   SELECT id, store_id, slug FROM landing_pages WHERE checkout_provider = 'external';
--   UPDATE landing_pages SET checkout_provider = 'shopify' WHERE id IN (...);  -- decisão humana
-- (cta_config.externalCheckout pode ficar; é ignorado fora do modo external.)
--
-- O LOCK vem antes da checagem para impedir que uma linha 'external' seja
-- gravada entre a contagem e a troca do CHECK.
-- Idempotente: reexecutar com zero linhas 'external' produz o mesmo estado.

BEGIN;

LOCK TABLE "landing_pages" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_external integer;
BEGIN
  SELECT count(*) INTO v_external
    FROM "landing_pages"
   WHERE "checkout_provider" = 'external';

  IF v_external > 0 THEN
    RAISE EXCEPTION
      'Rollback 0110 abortado: % landing_pages com checkout_provider = ''external''. Converta-as explicitamente (ex.: para ''shopify'') antes de restaurar o CHECK antigo.',
      v_external
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

ALTER TABLE "landing_pages"
  DROP CONSTRAINT IF EXISTS "landing_pages_checkout_provider_check";

ALTER TABLE "landing_pages"
  ADD CONSTRAINT "landing_pages_checkout_provider_check"
  CHECK ("checkout_provider" IN ('shopify', 'stripe'));

COMMENT ON COLUMN landing_pages.checkout_provider
  IS 'shopify (padrão) | stripe. Decidido no servidor; trocar só após checklist (conta ativa, mercado, frete, preços).';

COMMIT;

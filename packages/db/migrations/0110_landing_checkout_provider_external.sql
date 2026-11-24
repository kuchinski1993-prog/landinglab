-- Migration 0110: landing_pages.checkout_provider aceita 'external' (Story 16.3, Epic 16 — Fase 3)
--
-- Numeração: 0110 = próximo livre conferindo origin/main (vai até 0108) e
-- TODAS as branches locais/remotas (nenhuma tem 0110; 0109 = sphere_offers).
-- Renumerar no merge se outra migration entrar antes.
--
-- Escopo MÍNIMO (exceção aprovada pelo @po à restrição "não tocar em tabelas
-- LandingLab"): troca APENAS o CHECK "landing_pages_checkout_provider_check",
-- criado na 0080 com ('shopify','stripe'), para ('shopify','stripe','external').
--   - nenhuma coluna, FK, índice ou default novo/alterado (default segue 'shopify');
--   - nenhum dado existente é alterado (todas as linhas atuais já satisfazem o
--     CHECK novo, que é um superconjunto do antigo);
--   - o mapa kit -> URL do 'external' vive em landing_pages.cta_config (jsonb
--     existente, chave externalCheckout) — sem schema novo.
--
-- Idempotente: DROP CONSTRAINT IF EXISTS + ADD dentro da mesma transação
-- (reexecutar produz o mesmo estado). ADD CONSTRAINT valida as linhas
-- existentes; landing_pages é pequena, o lock ACCESS EXCLUSIVE é curto.
--
-- NÃO APLICADA nesta story (AC 20): validação em banco descartável é gate
-- humano; produção só com aprovação humana (P1/P3).
-- Rollback: 0110_landing_checkout_provider_external.rollback.sql (protegido:
-- aborta se existir landing com checkout_provider = 'external').

BEGIN;

ALTER TABLE "landing_pages"
  DROP CONSTRAINT IF EXISTS "landing_pages_checkout_provider_check";

ALTER TABLE "landing_pages"
  ADD CONSTRAINT "landing_pages_checkout_provider_check"
  CHECK ("checkout_provider" IN ('shopify', 'stripe', 'external'));

COMMENT ON COLUMN landing_pages.checkout_provider
  IS 'shopify (padrão) | stripe | external (Story 16.3: navegação direta para checkout de terceiro, mapa kit->URL em cta_config.externalCheckout). Decidido no servidor; trocar só após checklist.';

COMMIT;

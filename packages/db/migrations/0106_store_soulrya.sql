-- Migration 0106: cadastro da loja SOULRYA (Story 23.2)
--
-- Numeração PROVISÓRIA: a 0106 só vale se nada entrar antes (última em main: 0105). Se outra onda
-- entrar primeiro, renumerar no merge — este arquivo não depende de nenhuma migration posterior à
-- 0033 (stores.settings). Ordem da onda 17: 0106 (23.2) → 0107 (23.3) → 0108 (23.4).
--
-- O que faz: insere UMA linha em `stores` — id 'soulrya', nome 'SOULRYA', ativa, sem domínio e sem
-- domínio Shopify, com a região "Brasil" em `settings` (exatamente o que POST /stores gravaria com
-- currency/locale/timezone). SEM `checkoutEnabled`: loja ≠ default só vende com
-- settings.checkoutEnabled === true (fail-closed, 17.4a) — a SOULRYA não vende até a 23.5/17.8.
--
-- domain = NULL de propósito: o host provisório e depois soulrya.com.br entram pela tela
-- Configurações → Endereço (17.3b, que valida e exige unicidade). Um domínio errado gravado aqui
-- "sequestraria" o host quando a vitrine resolver a loja pelo domínio (23.1a).
--
-- Sem linhas em store_modules (ausência = tudo ligado, 0096). Não toca credenciais, políticas,
-- e-mails, temas nem a linha 'default'. Sem tabela nova → sem RLS.
--
-- Idempotente: ON CONFLICT (id) DO NOTHING — se a 'soulrya' já foi criada pela tela "Lojas", ela
-- fica exatamente como está (nome, domínio, settings preservados).
-- Rollback: 0106_store_soulrya.rollback.sql (só apaga se a loja continuar vazia).

BEGIN;

INSERT INTO "stores" ("id", "name", "domain", "shopify_domain", "is_active", "settings")
VALUES (
  'soulrya',
  'SOULRYA',
  NULL,
  NULL,
  true,
  '{"currency":"BRL","locale":"pt-BR","timezone":"America/Sao_Paulo"}'::jsonb
)
ON CONFLICT ("id") DO NOTHING;

COMMIT;

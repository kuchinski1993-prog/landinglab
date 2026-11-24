-- Migration 0041 — Sync automático de preço multi-moeda (Fase 2 Bloco 3.1).
--
-- Base: docs/research/2026-07-11-moeda-dinamica-fechada.md §3.8.
--
-- Adiciona 3 colunas em `products` para rastrear o estado do sync de
-- preço multi-moeda que empurra preço fixo por moeda para as PriceLists
-- da Shopify (EUR/USD/BRL). O sync é processado pelo BullMQ:
--
--   - price_sync_status: 'pending' | 'synced' | 'error'
--     - 'pending' = ainda não sincronizado OU aguardando processamento.
--     - 'synced'  = último sync com sucesso.
--     - 'error'   = último sync falhou (mensagem em price_sync_error).
--   - price_sync_error: mensagem do último erro (NULL após sucesso).
--   - price_synced_at:  timestamp do último sync com sucesso.
--
-- Backfill: default 'pending' para todos os produtos existentes — start
-- clean, sem presumir estado histórico. Primeiro sync popula para
-- 'synced' ou 'error'.
--
-- Índice parcial: cobre triagem rápida de produtos que precisam de
-- atenção (pending pendurados + errors). Não pesa nas linhas 'synced'.
--
-- Idempotente: IF NOT EXISTS em tudo (colunas + índice).

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "price_sync_status" text DEFAULT 'pending' NOT NULL,
  ADD COLUMN IF NOT EXISTS "price_sync_error" text,
  ADD COLUMN IF NOT EXISTS "price_synced_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "idx_products_price_sync_status"
  ON "products" ("price_sync_status")
  WHERE price_sync_status IN ('pending', 'error');

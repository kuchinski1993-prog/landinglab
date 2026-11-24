-- Migration 0082: pós-venda da LandingLab (Story 15.4)
--
-- Spec: docs/architecture/landinglab-stripe-checkout.md §4.5, §4.6, §5.5, §5.6, §6.2 (D12–D16)
--
-- landing_order_events: timeline do pedido (fonte do painel LandingLab → Pedidos
--   e da página pública /rastreio). Só eventos com visible_to_customer = true
--   aparecem para o cliente. `dedupe_key` torna a gravação idempotente: o mesmo
--   webhook reprocessado não duplica eventos (UNIQUE (order_id, dedupe_key)).
--   Tipos: paid, preparing, shipped, refunded, email_sent, email_failed, note.
-- landing_orders: tracking_url / shipped_at / preparing_at. Código e
--   transportadora continuam em fulfillment_tracking / fulfillment_carrier
--   (colados manualmente pelo owner — o sistema nunca gera rastreio, D13).
--   Status ganha 'preparing' (job "em preparação", 48h após o pagamento).
-- landing_markets.seller_info: identidade jurídica do vendedor usada nas
--   políticas (razão social, endereço, VAT, prazo de devolução, quem paga a
--   devolução). Enquanto razão social/endereço estiverem vazios, nenhuma
--   política do mercado pode ser publicada (Story 15.4, decisão 10).
--
-- RLS habilitado sem policies (padrão 0076).
-- Rollback: 0082_landing_post_sale.rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "landing_order_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL REFERENCES "landing_orders"("id") ON DELETE CASCADE,
  "store_id" text NOT NULL DEFAULT 'l0i',
  "type" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "visible_to_customer" boolean NOT NULL DEFAULT false,
  "dedupe_key" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "landing_order_events_type_check" CHECK ("type" IN (
    'paid', 'preparing', 'shipped', 'refunded', 'email_sent', 'email_failed', 'note'
  ))
);

CREATE INDEX IF NOT EXISTS "idx_landing_order_events_order"
  ON "landing_order_events" ("order_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_order_events_dedupe"
  ON "landing_order_events" ("order_id", "dedupe_key") WHERE "dedupe_key" IS NOT NULL;

ALTER TABLE "landing_orders"
  ADD COLUMN IF NOT EXISTS "tracking_url" text,
  ADD COLUMN IF NOT EXISTS "shipped_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "preparing_at" timestamptz;

ALTER TABLE "landing_orders" DROP CONSTRAINT IF EXISTS "landing_orders_status_check";
ALTER TABLE "landing_orders" ADD CONSTRAINT "landing_orders_status_check"
  CHECK ("status" IN (
    'pending', 'paid', 'preparing', 'shipped', 'delivered',
    'refunded', 'cancelled', 'chargeback', 'failed'
  ));

-- Job "em preparação": pedidos pagos aguardando a janela de 48h.
CREATE INDEX IF NOT EXISTS "idx_landing_orders_paid_waiting"
  ON "landing_orders" ("paid_at") WHERE "status" = 'paid';

ALTER TABLE "landing_markets"
  ADD COLUMN IF NOT EXISTS "seller_info" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "landing_order_events" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE landing_order_events
  IS 'Timeline do pedido LandingLab (Story 15.4). visible_to_customer = aparece em /rastreio. dedupe_key = idempotência.';
COMMENT ON COLUMN landing_orders.tracking_url
  IS 'Link de rastreio REAL informado pelo owner (opcional). Nunca gerado pelo sistema.';
COMMENT ON COLUMN landing_markets.seller_info
  IS 'Identidade jurídica para as políticas: {legalName, legalAddress, vatId?, refundWindowDays?, returnShippingPayer?}.';
COMMENT ON COLUMN landing_markets.policies
  IS 'Políticas do mercado: {"<slug>": {status: draft|published, html?, updatedAt, publishedAt?}}. Sem html = texto padrão.';

COMMIT;

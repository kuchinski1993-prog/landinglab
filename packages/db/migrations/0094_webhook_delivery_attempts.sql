-- Migration 0094: tentativas de entrega do webhook Shopify + Purchase único (Story 0.2)
--
-- 1. Tabela webhook_delivery_attempts: uma linha por (X-Shopify-Webhook-Id, tópico).
--    O handler de orders/paid registra cada entrega: 'failed' quando o pedido
--    não pôde ser gravado (a API responde 503 e a Shopify reenvia),
--    'tracking_pending' quando o pedido foi gravado mas o tracking/CAPI ainda
--    não, e 'processed' quando está tudo gravado. O script
--    apps/api/src/scripts/reprocess-shopify-orders.ts lê esta tabela.
--    Nunca guarda e-mail/telefone (last_error é sanitizado no código).
--
-- 2. Índice único parcial em tracking_events (event_name, event_id) WHERE
--    event_name = 'Purchase': garante no máximo 1 Purchase por pedido mesmo
--    com reenvios simultâneos. Só é criado se NÃO houver duplicatas hoje —
--    havendo, a migration avisa (NOTICE) e segue sem o índice; depois da
--    limpeza aprovada pelo owner, rode esta migration de novo (é idempotente).
--
--    ATENÇÃO (lock): o CREATE UNIQUE INDEX roda dentro da transação, sem
--    CONCURRENTLY, e bloqueia escritas em tracking_events enquanto varre a
--    tabela (visit/pageview também gravam nela). Antes de aplicar, confira o
--    tamanho (SELECT count(*) FROM tracking_events) e aplique em horário de
--    baixo tráfego. Se a tabela for grande, crie o índice antes, fora de
--    transação:
--      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_tracking_events_purchase_event_id
--        ON tracking_events (event_name, event_id) WHERE event_name = 'Purchase';
--    (o IF NOT EXISTS abaixo então vira no-op).
--
--    Pré-checagem manual:
--      SELECT event_id, count(*) FROM tracking_events
--      WHERE event_name = 'Purchase' GROUP BY event_id HAVING count(*) > 1;
--
-- RLS: nasce habilitado sem policies (deny-all para anon/authenticated, padrão
-- da 0092). O backend conecta como postgres (BYPASSRLS).
--
-- Idempotente (IF NOT EXISTS). Rollback: 0094_webhook_delivery_attempts.rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "webhook_delivery_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'default',
  "webhook_id" text NOT NULL,
  "topic" text NOT NULL,
  "order_id" text,
  "status" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 1,
  "error_code" text,
  "last_error" text,
  "first_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "webhook_delivery_attempts_status_check"
    CHECK ("status" IN ('failed', 'tracking_pending', 'processed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_webhook_delivery_attempts_webhook_topic"
  ON "webhook_delivery_attempts" ("webhook_id", "topic");
CREATE INDEX IF NOT EXISTS "idx_webhook_delivery_attempts_pending"
  ON "webhook_delivery_attempts" ("status", "last_attempt_at")
  WHERE "status" IN ('failed', 'tracking_pending');
CREATE INDEX IF NOT EXISTS "idx_webhook_delivery_attempts_order"
  ON "webhook_delivery_attempts" ("order_id");

ALTER TABLE "webhook_delivery_attempts" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT 1 FROM "tracking_events"
    WHERE "event_name" = 'Purchase'
    GROUP BY "event_id"
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE NOTICE '0094: % event_id(s) de Purchase duplicados em tracking_events — índice único NÃO criado. Liste com a pré-checagem do cabeçalho, limpe com aprovação do owner e rode a 0094 de novo.', dup_count;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_tracking_events_purchase_event_id"
      ON "tracking_events" ("event_name", "event_id")
      WHERE "event_name" = 'Purchase';
  END IF;
END $$;

COMMIT;

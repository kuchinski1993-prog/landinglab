-- Migration 0083: suporte da LandingLab (Story 15.5)
--
-- Spec: docs/architecture/landinglab-stripe-checkout.md §5.7, D14, D17, P1
--
-- Caixa de suporte própria da LandingLab (support@pathmetric.online, recebido
-- via Resend Inbound). Tabelas SEPARADAS do TrustShield (inbound_emails /
-- conversation_threads): mensagens LandingLab não aparecem em /inbox e vice-
-- versa (decisão 1 do owner, 2026-10-06).
--
-- landing_support_threads: conversa com um cliente (vínculo opcional com o
--   pedido Stripe da LandingLab). auth_fail = SPF e DKIM falharam (sem resposta
--   automática). sender_matches_order = e-mail do remetente bate com o do
--   pedido vinculado (false → nenhuma informação do pedido em resposta
--   automática). auto_ack_sent_at / last_where_is_my_order_at = travas das
--   respostas automáticas (1 ack por thread; 1 "onde está meu pedido" / 24 h).
-- landing_support_messages: mensagens imutáveis (só append). Mensagens
--   filtradas (bounce, auto-resposta, lista, próprio domínio) ficam com
--   filter_reason e thread_id NULL. Idempotência: UNIQUE parcial por
--   (store_id, provider_email_id) e (store_id, message_id).
--   delivery_status (outbound) = resultado real do provider gravado pelo worker.
-- landing_support_attachments: anexos guardados no bucket privado
--   (storage_key) ou só metadados quando descartados (discarded_reason).
--
-- RLS habilitado sem policies (padrão 0076). store_id padrão 'l0i'.
-- Rollback: 0083_landing_support.rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "landing_support_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" text NOT NULL DEFAULT 'l0i',
  "customer_email" text NOT NULL,
  "customer_email_normalized" text NOT NULL,
  "customer_name" text,
  "subject" text NOT NULL DEFAULT '',
  "subject_normalized" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'open',
  "order_id" uuid REFERENCES "landing_orders"("id") ON DELETE SET NULL,
  "order_link" text NOT NULL DEFAULT 'none',
  "sender_matches_order" boolean,
  "auth_fail" boolean NOT NULL DEFAULT false,
  "unread" boolean NOT NULL DEFAULT true,
  "auto_ack_sent_at" timestamptz,
  "last_where_is_my_order_at" timestamptz,
  "last_inbound_at" timestamptz,
  "last_outbound_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  CONSTRAINT "landing_support_threads_status_check" CHECK ("status" IN ('open', 'answered', 'closed')),
  CONSTRAINT "landing_support_threads_order_link_check" CHECK ("order_link" IN ('auto', 'manual', 'none'))
);

CREATE INDEX IF NOT EXISTS "idx_landing_support_threads_status"
  ON "landing_support_threads" ("store_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "idx_landing_support_threads_customer"
  ON "landing_support_threads" ("store_id", "customer_email_normalized");
CREATE INDEX IF NOT EXISTS "idx_landing_support_threads_order"
  ON "landing_support_threads" ("order_id");

CREATE TABLE IF NOT EXISTS "landing_support_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "thread_id" uuid REFERENCES "landing_support_threads"("id") ON DELETE CASCADE,
  "store_id" text NOT NULL DEFAULT 'l0i',
  "direction" text NOT NULL,
  "kind" text NOT NULL,
  "provider_email_id" text,
  "message_id" text,
  "in_reply_to" text,
  "references_ids" text[] NOT NULL DEFAULT '{}'::text[],
  "from_address" text NOT NULL,
  "from_name" text,
  "to_address" text NOT NULL,
  "subject" text NOT NULL DEFAULT '',
  "text_body" text NOT NULL DEFAULT '',
  "spf_result" text,
  "dkim_result" text,
  "filter_reason" text,
  "delivery_status" text,
  "delivery_error" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "landing_support_messages_direction_check" CHECK ("direction" IN ('inbound', 'outbound')),
  CONSTRAINT "landing_support_messages_kind_check"
    CHECK ("kind" IN ('customer', 'manual', 'auto_ack', 'auto_where_is_my_order', 'forward')),
  CONSTRAINT "landing_support_messages_delivery_check"
    CHECK ("delivery_status" IS NULL OR "delivery_status" IN ('queued', 'sent', 'failed', 'mock')),
  -- thread_id NULL só para mensagens filtradas (anti-loop).
  CONSTRAINT "landing_support_messages_thread_check" CHECK ("thread_id" IS NOT NULL OR "filter_reason" IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_support_messages_provider"
  ON "landing_support_messages" ("store_id", "provider_email_id") WHERE "provider_email_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_support_messages_message_id"
  ON "landing_support_messages" ("store_id", "message_id") WHERE "message_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_landing_support_messages_thread"
  ON "landing_support_messages" ("thread_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_landing_support_messages_auto"
  ON "landing_support_messages" ("store_id", "kind", "created_at") WHERE "direction" = 'outbound';

CREATE TABLE IF NOT EXISTS "landing_support_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "message_id" uuid NOT NULL REFERENCES "landing_support_messages"("id") ON DELETE CASCADE,
  "store_id" text NOT NULL DEFAULT 'l0i',
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL DEFAULT 0,
  "storage_key" text,
  "discarded_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_landing_support_attachments_message"
  ON "landing_support_attachments" ("message_id");

ALTER TABLE "landing_support_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "landing_support_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "landing_support_attachments" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE landing_support_threads
  IS 'Suporte LandingLab (Story 15.5): conversas de support@pathmetric.online. Separado do TrustShield.';
COMMENT ON TABLE landing_support_messages
  IS 'Mensagens do suporte LandingLab (imutáveis). filter_reason + thread_id NULL = filtrada (bounce/auto/lista).';
COMMENT ON TABLE landing_support_attachments
  IS 'Anexos do suporte LandingLab. storage_key NULL + discarded_reason = descartado (só metadado).';

COMMIT;

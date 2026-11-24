-- Migration 0032 — Disputes (Shopify Payments chargebacks/inquiries).
--
-- Contexto: o TrustShield antes só capturava `chargeback_threat` (ameaça
-- de chargeback vinda por e-mail). Esta tabela guarda a DISPUTA REAL
-- reportada pela Shopify Payments via webhooks `disputes/create` +
-- `disputes/update`.
--
-- Régua: nunca auto-submeter evidência. `evidence_draft` é rascunho
-- editável pelo dono; a submissão só acontece por endpoint dedicado
-- após aprovação explícita e SEMPRE registra `evidence_sent_on` +
-- `evidence_submitted_by`. Chargeback é decidido pelo banco — nunca
-- prometer vitória.
--
-- Aditiva. Sem drop de tabelas existentes.

CREATE TABLE IF NOT EXISTS "disputes" (
  -- Dispute id da Shopify (numérico ou GID como texto). PK.
  "id" text PRIMARY KEY,
  "store_id" text NOT NULL DEFAULT 'default',
  -- Pedido associado (soft ref: pode ser null se a Shopify não anexar).
  "order_id" text,
  -- 'chargeback' | 'inquiry' | outros (texto livre para extensão).
  "type" text,
  "amount" numeric(12, 2),
  "currency" text,
  -- Razão da Shopify: fraudulent | duplicate | credit_not_processed |
  -- customer_initiated | debit_not_authorized | product_not_received |
  -- product_unacceptable | general | ...
  "reason" text,
  "network_reason_code" text,
  -- Status: needs_response | under_review | won | lost | accepted |
  -- charge_refunded | outros.
  "status" text NOT NULL DEFAULT 'needs_response',
  "evidence_due_by" timestamptz,
  "evidence_sent_on" timestamptz,
  "finalized_on" timestamptz,
  "initiated_at" timestamptz,
  -- Rascunho de evidência (jsonb — evita nova tabela). Estrutura:
  -- {
  --   "customer_communication": "...",
  --   "shipping_carrier": "...",
  --   "shipping_tracking_number": "...",
  --   "shipping_date": "...",
  --   "shipping_address": "...",
  --   "product_description": "...",
  --   "refund_policy_disclosure": "...",
  --   "cancellation_policy_disclosure": "...",
  --   "uncategorized_text": "..."
  -- }
  -- Editável pelo dono via UI antes de submeter.
  "evidence_draft" jsonb,
  -- Quem aprovou e submeteu (auditoria). Preenchido pelo endpoint de
  -- submit após o clique de confirmação. Null enquanto draft.
  "evidence_submitted_by" text,
  -- Payload cru do webhook (última versão recebida). Para auditoria e
  -- para preencher campos novos que ainda não temos coluna própria.
  "raw" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Índices para as consultas do painel:
--   lista por status (needs_response primeiro),
--   busca por pedido (correlação no dossiê),
--   ordenação por prazo (countdown honesto).
CREATE INDEX IF NOT EXISTS "idx_disputes_store_status"
  ON "disputes" ("store_id", "status");
CREATE INDEX IF NOT EXISTS "idx_disputes_store_order"
  ON "disputes" ("store_id", "order_id");
CREATE INDEX IF NOT EXISTS "idx_disputes_due_by"
  ON "disputes" ("evidence_due_by");

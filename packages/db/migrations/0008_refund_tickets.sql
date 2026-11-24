-- Story 11.1 — TrustShield refund tickets and conversation thread.
-- refund_tickets is the case file (one per claim); refund_messages is the
-- conversational thread between customer, AI agent and operator.

CREATE TABLE IF NOT EXISTS refund_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL,
  order_id text NOT NULL,
  customer_email text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  reason_category text,
  ai_recommendation text,
  ai_confidence numeric(4,3),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refund_tickets_store ON refund_tickets (store_id);
CREATE INDEX IF NOT EXISTS idx_refund_tickets_status ON refund_tickets (status);
CREATE INDEX IF NOT EXISTS idx_refund_tickets_created ON refund_tickets (created_at DESC);

CREATE TABLE IF NOT EXISTS refund_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES refund_tickets(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refund_messages_ticket ON refund_messages (ticket_id);
CREATE INDEX IF NOT EXISTS idx_refund_messages_created ON refund_messages (created_at);

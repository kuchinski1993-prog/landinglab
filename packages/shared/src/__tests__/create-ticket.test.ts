// Testes do helper de criação de refund ticket. Usa fake db (Drizzle chain
// mock) — o objetivo é validar shape/idempotência/rastreabilidade, não
// exercitar Postgres.

import { refundMessages, refundTickets } from '@blackshop/db';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RECEIPT_TEXT,
  createRefundTicket,
  findExistingOpenTicket,
} from '../refunds/create-ticket.js';

interface FakeTicket {
  id: string;
  storeId: string;
  orderId: string;
  customerEmail: string;
  status: string;
  reasonCategory: string | null;
  source: string | null;
  sourceInboundEmailId: string | null;
}

interface FakeMessage {
  id: string;
  ticketId: string;
  role: string;
  content: string;
}

interface FakeState {
  tickets: FakeTicket[];
  messages: FakeMessage[];
  nextTicketId: number;
  nextMessageId: number;
  filterSourceInbound: string | null;
  filterStore: string | null;
}

function makeState(): FakeState {
  return {
    tickets: [],
    messages: [],
    nextTicketId: 1,
    nextMessageId: 1,
    filterSourceInbound: null,
    filterStore: null,
  };
}

// Drizzle-chain minimal para os métodos usados por createRefundTicket +
// findExistingOpenTicket: insert().values().returning(); select().from().where().limit()
function makeDb(state: FakeState): Parameters<typeof createRefundTicket>[0] {
  function buildSelect(): Record<string, unknown> {
    const exec = (): Array<{ id: string }> => {
      let rows = state.tickets;
      if (state.filterStore) rows = rows.filter((t) => t.storeId === state.filterStore);
      if (state.filterSourceInbound)
        rows = rows.filter((t) => t.sourceInboundEmailId === state.filterSourceInbound);
      return rows.map((t) => ({ id: t.id }));
    };
    const b: Record<string, unknown> = {};
    b['from'] = () => b;
    b['where'] = () => b;
    b['limit'] = () => Promise.resolve(exec());
    return b;
  }

  return {
    select: () => buildSelect(),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => ({
        returning: (_cols?: unknown) => {
          void _cols;
          // Identidade por reference: refundTickets/refundMessages são
          // imports estáveis do @blackshop/db. Comparação direta funciona.
          const isTickets = table === refundTickets;
          const isMessages = table === refundMessages;
          const tableName = isTickets
            ? 'refund_tickets'
            : isMessages
              ? 'refund_messages'
              : tableNameFrom(table);
          if (tableName === 'refund_tickets') {
            const id = `ticket-${state.nextTicketId++}`;
            const row: FakeTicket = {
              id,
              storeId: v['storeId'] as string,
              orderId: v['orderId'] as string,
              customerEmail: v['customerEmail'] as string,
              status: (v['status'] as string) ?? 'open',
              reasonCategory: (v['reasonCategory'] as string) ?? null,
              source: (v['source'] as string) ?? null,
              sourceInboundEmailId: (v['sourceInboundEmailId'] as string) ?? null,
            };
            state.tickets.push(row);
            return Promise.resolve([{ id }]);
          }
          if (tableName === 'refund_messages') {
            const id = `msg-${state.nextMessageId++}`;
            state.messages.push({
              id,
              ticketId: v['ticketId'] as string,
              role: v['role'] as string,
              content: v['content'] as string,
            });
            return Promise.resolve([{ id }]);
          }
          throw new Error(`unexpected table: ${tableName}`);
        },
      }),
    }),
  } as never;
}

function tableNameFrom(t: unknown): string {
  // Nossos schemas exports vêm com _.name em drizzle-orm; para o mock,
  // detectamos pelo objeto — cada chamada de insert vem com uma referência
  // única. Como só usamos 2 tabelas, distinguimos pela ordem de inserts
  // dentro de createRefundTicket (ticket → customer msg → receipt msg).
  // Truque simples: usar identity.
  const anyT = t as { _?: { name?: string }; name?: string };
  const name = anyT?._?.name ?? anyT?.name ?? '';
  if (name.includes('ticket')) return 'refund_tickets';
  if (name.includes('message')) return 'refund_messages';
  // fallback via referência do objeto compartilhado
  const s = String(t);
  if (s.includes('refund_tickets')) return 'refund_tickets';
  if (s.includes('refund_messages')) return 'refund_messages';
  return 'unknown';
}

describe('createRefundTicket', () => {
  it('cria ticket + customer message + receipt message (default text)', async () => {
    const state = makeState();
    const db = makeDb(state);
    const result = await createRefundTicket(db, {
      storeId: 'default',
      orderId: 'order-7435',
      customerEmail: 'John@Gmail.com',
      customerMessage: 'I want a refund',
      source: 'inbound_email',
      sourceInboundEmailId: 'inbound-1',
    });
    expect(result.ticketId).toBeDefined();
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0]!.source).toBe('inbound_email');
    expect(state.tickets[0]!.sourceInboundEmailId).toBe('inbound-1');
    // email normalizado (lowercase) na coluna
    expect(state.tickets[0]!.customerEmail).toBe('john@gmail.com');
    expect(state.tickets[0]!.status).toBe('open');
    // 2 mensagens: customer + receipt
    expect(state.messages).toHaveLength(2);
    const customerMsg = state.messages.find((m) => m.role === 'customer');
    const receiptMsg = state.messages.find((m) => m.role === 'operator');
    expect(customerMsg?.content).toBe('I want a refund');
    expect(receiptMsg?.content).toBe(DEFAULT_RECEIPT_TEXT);
    expect(result.receiptMessageId).toBe(receiptMsg?.id ?? null);
  });

  it('passa receiptText=null → pula receipt message', async () => {
    const state = makeState();
    const db = makeDb(state);
    const result = await createRefundTicket(db, {
      storeId: 'default',
      orderId: 'order-1',
      customerEmail: 'a@x.com',
      customerMessage: 'hi',
      source: 'inbound_email',
      receiptText: null,
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.role).toBe('customer');
    expect(result.receiptMessageId).toBeNull();
  });

  it('source storefront_form: retro-compat do fluxo do portal', async () => {
    const state = makeState();
    const db = makeDb(state);
    await createRefundTicket(db, {
      storeId: 'default',
      orderId: 'order-1',
      customerEmail: 'a@x.com',
      customerMessage: 'hi',
      source: 'storefront_form',
      reasonCategory: 'defect',
    });
    expect(state.tickets[0]!.source).toBe('storefront_form');
    expect(state.tickets[0]!.sourceInboundEmailId).toBeNull();
    expect(state.tickets[0]!.reasonCategory).toBe('defect');
  });
});

describe('findExistingOpenTicket', () => {
  it('retorna ticket existente por sourceInboundEmailId (idempotência)', async () => {
    const state = makeState();
    state.tickets.push({
      id: 'ticket-existing',
      storeId: 'default',
      orderId: 'order-1',
      customerEmail: 'a@x.com',
      status: 'open',
      reasonCategory: null,
      source: 'inbound_email',
      sourceInboundEmailId: 'inbound-1',
    });
    state.filterStore = 'default';
    state.filterSourceInbound = 'inbound-1';
    const db = makeDb(state);
    const found = await findExistingOpenTicket(db, {
      storeId: 'default',
      orderId: 'order-1',
      customerEmail: 'a@x.com',
      sourceInboundEmailId: 'inbound-1',
    });
    expect(found?.id).toBe('ticket-existing');
  });

  it('sem sourceInboundEmailId → não deduplica (portal preserva comportamento)', async () => {
    const state = makeState();
    const db = makeDb(state);
    const found = await findExistingOpenTicket(db, {
      storeId: 'default',
      orderId: 'order-1',
      customerEmail: 'a@x.com',
    });
    expect(found).toBeNull();
  });
});

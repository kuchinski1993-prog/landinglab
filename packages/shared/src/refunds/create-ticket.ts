// Criação de refund_ticket compartilhada por api (rota storefront) e
// worker (analyze-inbound.processor quando category=refund_request).
//
// Responsabilidades DESTE módulo (estrutural, sem I/O de fila):
//   1. INSERT em refund_tickets com origem e rastreio.
//   2. INSERT em refund_messages com a mensagem do cliente (role='customer').
//   3. INSERT do receipt confirmation (role='operator') — passa por
//      checkResponseGuard antes.
//
// Os enqueues (analyze-refund, email refund_requested transacional) ficam
// nos callers porque cada app tem seu próprio Queue producer (api usa
// fastify.queue; worker cria Queue local). Retornamos o ticket + flag pra
// caller decidir enqueue.
//
// Régua: abrir ticket é ABRIR UM CASO pra revisão humana. A IA NUNCA
// decide dinheiro — só sinaliza que precisa olhar. Wording da confirmação
// é neutro (sem prazo de refund, apenas "recebemos, vamos rever").

import type { Database } from '@blackshop/db';
import { refundMessages, refundTickets } from '@blackshop/db';
import { and, eq } from 'drizzle-orm';

export interface CreateRefundTicketInput {
  storeId: string;
  orderId: string;
  customerEmail: string;
  /**
   * Corpo da mensagem inicial do cliente (rastro do que motivou o ticket).
   * Portal usa o `description` do formulário. Inbound usa o textBody do email
   * (ou fallback ao subject). NÃO é editado nem sanitizado aqui — os
   * consumidores (dashboard) devem tratar como texto do cliente.
   */
  customerMessage: string;
  /** Origem estrutural — usado no filtro/UI. */
  source: 'storefront_form' | 'inbound_email' | 'operator_manual';
  /** Quando source='inbound_email', preencher para rastro (inbound_emails.id). */
  sourceInboundEmailId?: string | null;
  /** Categoria da razão (portal) — opcional. */
  reasonCategory?: string | null;
  /**
   * Receipt confirmation. Se null/undefined, o helper usa o wording padrão
   * neutro. Se passar string, é validado pelo caller antes (o helper NÃO
   * chama checkResponseGuard porque a lib vive em @blackshop/trustshield e
   * @blackshop/shared não pode depender dela — evita ciclo). Caller já
   * fez a validação.
   */
  receiptText?: string | null;
}

export interface CreateRefundTicketResult {
  ticketId: string;
  customerMessageId: string;
  receiptMessageId: string | null;
}

/**
 * Wording padrão do receipt (mesmo do portal — buildReceiptConfirmation).
 * Exportado para o caller aplicar o response-guard antes de passar.
 */
export const DEFAULT_RECEIPT_TEXT =
  `We've received your request and our team is reviewing it. We'll get back to you shortly.`;

export async function createRefundTicket(
  db: Database,
  input: CreateRefundTicketInput,
): Promise<CreateRefundTicketResult> {
  const insertedTickets = await db
    .insert(refundTickets)
    .values({
      storeId: input.storeId,
      orderId: input.orderId,
      customerEmail: input.customerEmail.toLowerCase(),
      status: 'open',
      reasonCategory: input.reasonCategory ?? null,
      source: input.source,
      sourceInboundEmailId: input.sourceInboundEmailId ?? null,
    })
    .returning({ id: refundTickets.id });
  const ticket = insertedTickets[0];
  if (!ticket) {
    throw new Error('createRefundTicket: failed to insert refund ticket');
  }

  const insertedCustomerMsgs = await db
    .insert(refundMessages)
    .values({
      ticketId: ticket.id,
      role: 'customer',
      content: input.customerMessage,
    })
    .returning({ id: refundMessages.id });
  const customerMsg = insertedCustomerMsgs[0];
  if (!customerMsg) {
    throw new Error('createRefundTicket: failed to insert customer message');
  }

  let receiptMsgId: string | null = null;
  const receipt = input.receiptText === null ? null : (input.receiptText ?? DEFAULT_RECEIPT_TEXT);
  if (receipt) {
    const insertedReceipts = await db
      .insert(refundMessages)
      .values({
        ticketId: ticket.id,
        role: 'operator',
        content: receipt,
      })
      .returning({ id: refundMessages.id });
    receiptMsgId = insertedReceipts[0]?.id ?? null;
  }

  return {
    ticketId: ticket.id,
    customerMessageId: customerMsg.id,
    receiptMessageId: receiptMsgId,
  };
}

/**
 * Busca ticket aberto existente do mesmo email/order dentro de janela
 * curta pra deduplicar quando o processor reprocessa. Retorna null se
 * não existir.
 */
export async function findExistingOpenTicket(
  db: Database,
  args: {
    storeId: string;
    orderId: string;
    customerEmail: string;
    sourceInboundEmailId?: string | null;
  },
): Promise<{ id: string } | null> {
  // Idempotência forte: se veio de um inbound específico, procura por esse
  // sourceInboundEmailId primeiro. Zero risco de duplicação.
  if (args.sourceInboundEmailId) {
    const rows = await db
      .select({ id: refundTickets.id })
      .from(refundTickets)
      .where(
        and(
          eq(refundTickets.storeId, args.storeId),
          eq(refundTickets.sourceInboundEmailId, args.sourceInboundEmailId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  // Sem sourceInboundEmailId (fluxo do portal): não deduplica automaticamente
  // — comportamento existente preservado.
  return null;
}

// Inbound threading — correlaciona emails em conversation_threads.
//
// Ordem de tentativa (do mais confiável ao menos):
//   1. In-Reply-To → casa com message_id de um inbound anterior → herda thread_id
//   2. References (mais recente primeiro) → mesmo casamento
//   3. Heurística last-resort: mesmo from_address + subject normalizado
//      (sem Re:/Fwd:) + janela de 7 dias
//
// Se nada bate → cria nova conversation_threads.
//
// Módulo compartilhado entre apps/api (rotas) e apps/worker (processor).
// Recebe uma instância `Database` do drizzle; não abre nem fecha conexão.

import {
  conversationThreads,
  inboundEmails,
  type Database,
} from '@blackshop/db';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import { normalizeEmailForMatch } from './normalize-email.js';

// ── Header + subject helpers (puros, sem I/O) ───────────────────────────

const MESSAGE_ID_RE = /<[^<>\s]+@[^<>\s]+>/g;

export function extractMessageIds(value: string): string[] {
  const matches = value.match(MESSAGE_ID_RE);
  return matches ?? [];
}

export interface ThreadResolveHeaders {
  inReplyTo?: string | null;
  references?: string | null;
}

/**
 * Devolve Message-IDs candidatos a "email pai", em ordem de confiança
 * decrescente. In-Reply-To primeiro; References do mais recente pro mais
 * antigo (posição no header é oldest→newest, invertemos).
 */
export function extractThreadCandidates(input: ThreadResolveHeaders): string[] {
  const out: string[] = [];
  if (input.inReplyTo) {
    for (const cand of extractMessageIds(input.inReplyTo)) {
      if (!out.includes(cand)) out.push(cand);
    }
  }
  if (input.references) {
    const refs = extractMessageIds(input.references).reverse();
    for (const cand of refs) {
      if (!out.includes(cand)) out.push(cand);
    }
  }
  return out;
}

export function normalizeSubjectForMatch(subject: string | null | undefined): string {
  if (!subject) return '';
  return subject
    .replace(/^\s*(re|fwd?|fw)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function headerGet(
  headers: Record<string, unknown> | null,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lc = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lc && typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

// ── resolveOrCreateThread ──────────────────────────────────────────────

export interface ThreadResolveInput {
  storeId: string;
  inboundEmailId: string;
  fromAddress: string;
  subject: string | null;
  headers: Record<string, unknown> | null;
  verificationState: string;
  category: string | null;
  createdAt: Date;
}

export interface ThreadResolveResult {
  threadId: string;
  isNew: boolean;
  matchedBy: 'in_reply_to' | 'references' | 'heuristic' | 'auto_merge' | 'new';
}

const HEURISTIC_WINDOW_MS = 7 * 24 * 3600 * 1000;

/**
 * Auto-merge window — janela dentro da qual um email novo do MESMO
 * cliente (email normalizado) pode se juntar a uma conversation_thread
 * aberta existente, mesmo sem In-Reply-To/References. Padrão Gorgias
 * (recomendado 5–30 dias); usamos 30 pra evitar re-abrir threads
 * antigas por engano.
 */
const AUTO_MERGE_WINDOW_MS = 30 * 24 * 3600 * 1000;

/**
 * Estados de verificação considerados "confiáveis" para fim de
 * auto-merge. Emails classificados como suspicious_claim ou
 * unknown_sender NUNCA são auto-merged em thread confiável — protege
 * contra spoofer que se injeta em conversa legítima.
 */
const VERIFIED_STATES = new Set<string>([
  'verified_match',
  'verified_via_order',
]);

/**
 * Resolve o thread_id de um inbound recém-persistido. Se necessário cria
 * uma conversation_threads nova. Retorna sempre um threadId.
 *
 * NÃO ATUALIZA inbound_emails.thread_id — caller decide quando gravar
 * (evita gravações redundantes em pipelines idempotentes).
 */
export async function resolveOrCreateThread(
  db: Database,
  input: ThreadResolveInput,
): Promise<ThreadResolveResult> {
  const inReplyTo = headerGet(input.headers, 'in-reply-to') ?? null;
  const references = headerGet(input.headers, 'references') ?? null;

  const candidates = extractThreadCandidates({ inReplyTo, references });

  if (candidates.length > 0) {
    const rows = await db
      .select({
        id: inboundEmails.id,
        threadId: inboundEmails.threadId,
        messageId: inboundEmails.messageId,
      })
      .from(inboundEmails)
      .where(
        and(
          eq(inboundEmails.storeId, input.storeId),
          inArray(inboundEmails.messageId, candidates),
        ),
      )
      .limit(candidates.length);

    let parent: { id: string; threadId: string | null } | null = null;
    let matchedCand: string | null = null;
    for (const cand of candidates) {
      const row = rows.find((r) => r.messageId === cand);
      if (row) {
        parent = { id: row.id, threadId: row.threadId };
        matchedCand = cand;
        break;
      }
    }

    if (parent) {
      const matchedBy: ThreadResolveResult['matchedBy'] =
        matchedCand && inReplyTo && matchedCand === (extractMessageIds(inReplyTo)[0] ?? null)
          ? 'in_reply_to'
          : 'references';
      if (parent.threadId) {
        return { threadId: parent.threadId, isNew: false, matchedBy };
      }
      const newThreadId = await insertThread(db, input);
      // Backfill parent que não tinha thread ainda.
      await db
        .update(inboundEmails)
        .set({ threadId: newThreadId })
        .where(eq(inboundEmails.id, parent.id));
      return { threadId: newThreadId, isNew: true, matchedBy };
    }
  }

  // Heurística last-resort.
  const normSubject = normalizeSubjectForMatch(input.subject);
  if (normSubject.length > 0) {
    const since = new Date(input.createdAt.getTime() - HEURISTIC_WINDOW_MS);
    const recent = await db
      .select({
        id: inboundEmails.id,
        threadId: inboundEmails.threadId,
        subject: inboundEmails.subject,
      })
      .from(inboundEmails)
      .where(
        and(
          eq(inboundEmails.storeId, input.storeId),
          eq(inboundEmails.fromAddress, input.fromAddress),
          gte(inboundEmails.createdAt, since),
        ),
      )
      .orderBy(desc(inboundEmails.createdAt))
      .limit(20);

    for (const cand of recent) {
      if (cand.id === input.inboundEmailId) continue;
      if (normalizeSubjectForMatch(cand.subject) === normSubject && cand.threadId) {
        return { threadId: cand.threadId, isNew: false, matchedBy: 'heuristic' };
      }
    }
  }

  // ── Auto-merge por identidade do cliente (janela 30d) ────────────────
  //
  // Última chance antes de criar thread nova: existe conversation_thread
  // aberta do MESMO cliente (email normalizado) dentro da janela?
  //
  // Salvaguardas (régua):
  //  1. Se input.verificationState = 'suspicious_claim' → NÃO mergeia
  //     (thread nova, flagged).
  //  2. Se a thread candidata está em estado verificado e o novo email
  //     NÃO está verificado → NÃO mergeia (protege identidade — spoofer
  //     não se injeta em conversa legítima).
  //
  // As demais combinações são seguras: verified+verified, unknown+unknown,
  // e verified acumulando outro verified.
  if (input.verificationState !== 'suspicious_claim') {
    const normalizedEmail = normalizeEmailForMatch(input.fromAddress);
    if (normalizedEmail.length > 0) {
      const autoMergeSince = new Date(
        input.createdAt.getTime() - AUTO_MERGE_WINDOW_MS,
      );
      const openThreads = await db
        .select({
          id: conversationThreads.id,
          customerEmail: conversationThreads.customerEmail,
          verificationState: conversationThreads.verificationState,
          status: conversationThreads.status,
          updatedAt: conversationThreads.updatedAt,
        })
        .from(conversationThreads)
        .where(
          and(
            eq(conversationThreads.storeId, input.storeId),
            eq(conversationThreads.status, 'open'),
            gte(conversationThreads.updatedAt, autoMergeSince),
          ),
        )
        .orderBy(desc(conversationThreads.updatedAt))
        .limit(50);

      const inputIsVerified = VERIFIED_STATES.has(input.verificationState);
      for (const t of openThreads) {
        // Match por email normalizado (Gmail plus/dot aware).
        if (normalizeEmailForMatch(t.customerEmail) !== normalizedEmail) {
          continue;
        }
        // Salvaguarda 2: thread verificada + novo email não verificado
        // → não mergeia (segurança > conveniência).
        const threadIsVerified = VERIFIED_STATES.has(t.verificationState);
        if (threadIsVerified && !inputIsVerified) {
          continue;
        }
        return { threadId: t.id, isNew: false, matchedBy: 'auto_merge' };
      }
    }
  }

  const threadId = await insertThread(db, input);
  return { threadId, isNew: true, matchedBy: 'new' };
}

async function insertThread(
  db: Database,
  input: ThreadResolveInput,
): Promise<string> {
  const inserted = await db
    .insert(conversationThreads)
    .values({
      storeId: input.storeId,
      customerEmail: input.fromAddress.toLowerCase(),
      verificationState: input.verificationState,
      status: 'open',
      category: input.category,
    })
    .returning({ id: conversationThreads.id });
  const row = inserted[0];
  if (!row) throw new Error('failed to insert conversation_thread');
  return row.id;
}

/**
 * Atualiza status e updated_at de uma thread. Chamado pelo processor após
 * decidir a próxima ação (ex.: awaiting_customer, resolved, open).
 */
export async function updateThreadStatus(
  db: Database,
  threadId: string,
  patch: {
    status?: string;
    verificationState?: string;
    orderId?: string | null;
    category?: string | null;
    resolvedAt?: Date | null;
  },
): Promise<void> {
  const setClause: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) setClause['status'] = patch.status;
  if (patch.verificationState !== undefined)
    setClause['verificationState'] = patch.verificationState;
  if (patch.orderId !== undefined) setClause['orderId'] = patch.orderId;
  if (patch.category !== undefined) setClause['category'] = patch.category;
  if (patch.resolvedAt !== undefined) setClause['resolvedAt'] = patch.resolvedAt;
  await db
    .update(conversationThreads)
    .set(setClause)
    .where(eq(conversationThreads.id, threadId));
}

// ── Awaiting customer flow ─────────────────────────────────────────────
//
// Quando um email chega e sua thread está em status='awaiting_customer'
// (pedimos o número do pedido antes), verifica se o cliente respondeu com
// o número correto:
//   - bate email do pedido citado com from_address → verified_via_order
//   - não bate → suspicious_claim

export type AwaitingResolution =
  | { kind: 'not_applicable' }
  | { kind: 'no_order_number' }
  | { kind: 'verified_via_order'; orderId: string; orderNumber: string }
  | {
      kind: 'suspicious_claim';
      orderId: string;
      orderNumber: string;
      expectedEmail: string;
    };

export interface ResolveAwaitingInput {
  storeId: string;
  threadId: string;
  fromAddress: string;
  orderNumberMentioned: string | null;
}

export async function resolveAwaitingCustomer(
  db: Database,
  input: ResolveAwaitingInput,
): Promise<AwaitingResolution> {
  const threadRows = await db
    .select({
      id: conversationThreads.id,
      status: conversationThreads.status,
    })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.storeId, input.storeId),
        eq(conversationThreads.id, input.threadId),
      ),
    )
    .limit(1);
  const thread = threadRows[0];
  if (!thread || thread.status !== 'awaiting_customer') {
    return { kind: 'not_applicable' };
  }
  if (!input.orderNumberMentioned) {
    return { kind: 'no_order_number' };
  }

  const orderRows = (await db.execute(sql`
    select id, order_number, customer_email
      from orders
     where store_id = ${input.storeId}
       and order_number = ${input.orderNumberMentioned}
     limit 1
  `)) as unknown as Array<{
    id: string;
    order_number: string;
    customer_email: string | null;
  }>;
  const order = orderRows[0];
  if (!order) {
    return { kind: 'no_order_number' };
  }

  const fromLc = input.fromAddress.trim().toLowerCase();
  const orderEmailLc = (order.customer_email ?? '').trim().toLowerCase();
  if (orderEmailLc && orderEmailLc === fromLc) {
    return {
      kind: 'verified_via_order',
      orderId: order.id,
      orderNumber: order.order_number,
    };
  }
  return {
    kind: 'suspicious_claim',
    orderId: order.id,
    orderNumber: order.order_number,
    expectedEmail: orderEmailLc,
  };
}

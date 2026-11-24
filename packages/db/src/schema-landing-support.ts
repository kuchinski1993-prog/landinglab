// Suporte LandingLab (Story 15.5) — caixa de support@cubipiccanti.online.
//
// Migration: packages/db/migrations/0083_landing_support.sql (aplicada
// manualmente pelo owner). Tabelas separadas do TrustShield (inbound_emails /
// conversation_threads) para que nenhuma mensagem cruze os dois painéis.
// Re-exportado em packages/db/src/index.ts.
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { landingOrders } from './schema-landinglab-core.js';

export const LANDING_SUPPORT_THREAD_STATUSES = ['open', 'answered', 'closed'] as const;
export type LandingSupportThreadStatus = (typeof LANDING_SUPPORT_THREAD_STATUSES)[number];

export const LANDING_SUPPORT_ORDER_LINKS = ['auto', 'manual', 'none'] as const;
export type LandingSupportOrderLink = (typeof LANDING_SUPPORT_ORDER_LINKS)[number];

export const LANDING_SUPPORT_MESSAGE_KINDS = [
  'customer',
  'manual',
  'auto_ack',
  'auto_where_is_my_order',
  'forward',
] as const;
export type LandingSupportMessageKind = (typeof LANDING_SUPPORT_MESSAGE_KINDS)[number];

export type LandingSupportDirection = 'inbound' | 'outbound';
export type LandingSupportDeliveryStatus = 'queued' | 'sent' | 'failed' | 'mock';

export const landingSupportThreads = pgTable(
  'landing_support_threads',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('l0i'),
    customerEmail: text('customer_email').notNull(),
    customerEmailNormalized: text('customer_email_normalized').notNull(),
    customerName: text('customer_name'),
    subject: text('subject').notNull().default(''),
    subjectNormalized: text('subject_normalized').notNull().default(''),
    status: text('status').$type<LandingSupportThreadStatus>().notNull().default('open'),
    orderId: uuid('order_id').references(() => landingOrders.id, { onDelete: 'set null' }),
    orderLink: text('order_link').$type<LandingSupportOrderLink>().notNull().default('none'),
    senderMatchesOrder: boolean('sender_matches_order'),
    authFail: boolean('auth_fail').notNull().default(false),
    unread: boolean('unread').notNull().default(true),
    autoAckSentAt: timestamp('auto_ack_sent_at', { withTimezone: true }),
    lastWhereIsMyOrderAt: timestamp('last_where_is_my_order_at', { withTimezone: true }),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index('idx_landing_support_threads_status').on(t.storeId, t.status, t.updatedAt),
    customerIdx: index('idx_landing_support_threads_customer').on(t.storeId, t.customerEmailNormalized),
    orderIdx: index('idx_landing_support_threads_order').on(t.orderId),
  }),
);

export const landingSupportMessages = pgTable(
  'landing_support_messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    threadId: uuid('thread_id').references(() => landingSupportThreads.id, { onDelete: 'cascade' }),
    storeId: text('store_id').notNull().default('l0i'),
    direction: text('direction').$type<LandingSupportDirection>().notNull(),
    kind: text('kind').$type<LandingSupportMessageKind>().notNull(),
    providerEmailId: text('provider_email_id'),
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    referencesIds: text('references_ids').array().notNull().default(sql`'{}'::text[]`),
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name'),
    toAddress: text('to_address').notNull(),
    subject: text('subject').notNull().default(''),
    textBody: text('text_body').notNull().default(''),
    spfResult: text('spf_result'),
    dkimResult: text('dkim_result'),
    filterReason: text('filter_reason'),
    deliveryStatus: text('delivery_status').$type<LandingSupportDeliveryStatus>(),
    deliveryError: text('delivery_error'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerIdx: uniqueIndex('idx_landing_support_messages_provider')
      .on(t.storeId, t.providerEmailId)
      .where(sql`provider_email_id IS NOT NULL`),
    messageIdIdx: uniqueIndex('idx_landing_support_messages_message_id')
      .on(t.storeId, t.messageId)
      .where(sql`message_id IS NOT NULL`),
    threadIdx: index('idx_landing_support_messages_thread').on(t.threadId, t.createdAt),
    autoIdx: index('idx_landing_support_messages_auto')
      .on(t.storeId, t.kind, t.createdAt)
      .where(sql`direction = 'outbound'`),
  }),
);

export const landingSupportAttachments = pgTable(
  'landing_support_attachments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    messageId: uuid('message_id')
      .notNull()
      .references(() => landingSupportMessages.id, { onDelete: 'cascade' }),
    storeId: text('store_id').notNull().default('l0i'),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    storageKey: text('storage_key'),
    discardedReason: text('discarded_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageIdx: index('idx_landing_support_attachments_message').on(t.messageId),
  }),
);

export type LandingSupportThread = typeof landingSupportThreads.$inferSelect;
export type LandingSupportMessage = typeof landingSupportMessages.$inferSelect;
export type LandingSupportAttachment = typeof landingSupportAttachments.$inferSelect;
